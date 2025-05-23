// server.js - PowerPoint Conversion Server v 1.5 with MongoDB Persistence
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');

const app = express();
const port = process.env.PORT || 3001;

// MongoDB connection setup
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/dworld';
console.log("Connecting to MongoDB at: " + mongoUri);

// Define MongoDB schema for presentations
const presentationSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  originalName: { type: String, required: true },
  title: { type: String, required: true },
  summary: { type: String, default: '' },
  author: { type: String, default: 'Anonymous' },
  authorId: { type: String },
  topics: [String],
  slideCount: { type: Number, default: 0 },
  slides: [String], // Array of slide URLs
  slideTexts: [String], // Array of slide texts
  converted: { type: Date, default: Date.now },
  isPlaceholder: { type: Boolean, default: false },
  viewCount: { type: Number, default: 0 },
  isDeleted: { type: Boolean, default: false }
});

const Presentation = mongoose.model('Presentation', presentationSchema);

// Middleware
app.use(cors());
app.use(express.json());

// Storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate a unique filename to prevent overwrites
    const uniqueName = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

// File filter to ensure only PowerPoint files are uploaded
const fileFilter = (req, file, cb) => {
  const allowedExtensions = ['.ppt', '.pptx', '.key'];
  const ext = path.extname(file.originalname).toLowerCase();
  
  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only PowerPoint files (.ppt, .pptx) and Keynote files (.key) are allowed'));
  }
};

// Set up multer upload
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB size limit
});

// In-memory storage for presentations (cache)
const presentations = {};

// In-memory database for presentations by topic (cache)
const presentationsByTopic = {};

// Track which users have seen which presentations
const userPresentationHistory = {};

// Function to load presentations from database on startup
async function loadPresentationsFromDatabase() {
  try {
    const dbPresentations = await Presentation.find({ isDeleted: false });
    console.log(`Loaded ${dbPresentations.length} presentations from database`);
    
    // Populate the in-memory storage from database
    dbPresentations.forEach(pres => {
      // Store in memory cache
      presentations[pres.id] = pres.toObject();
      
      // Update topic indexes
      (pres.topics || []).forEach(topic => {
        topic = topic.toLowerCase();
        if (!presentationsByTopic[topic]) {
          presentationsByTopic[topic] = [];
        }
        if (!presentationsByTopic[topic].includes(pres.id)) {
          presentationsByTopic[topic].push(pres.id);
        }
      });
    });
    
    console.log('Presentations successfully loaded from database to memory');
  } catch (err) {
    console.error(`Error loading presentations from database: ${err}`);
  }
}

// Function to check if LibreOffice is installed
function checkLibreOfficeInstallation() {
  try {
    console.log('Checking LibreOffice installation...');
    const result = execSync('which libreoffice || echo "not found"').toString().trim();
    if (result === "not found") {
      console.error('LibreOffice is not installed or not in PATH');
      return false;
    }
    console.log(`LibreOffice found at: ${result}`);
    return true;
  } catch (error) {
    console.error('Error checking for LibreOffice:', error.message);
    return false;
  }
}

// Function to create a placeholder image for when LibreOffice isn't available
function createPlaceholderImage(outputPath, slideNumber, title) {
  try {
    const placeholderText = `Placeholder for slide ${slideNumber}\nTitle: ${title}\n\nLibreOffice is not installed on the server,\nso actual slide conversion is not available.`;
    fs.writeFileSync(outputPath, placeholderText);
    console.log(`Created placeholder at ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`Error creating placeholder: ${error.message}`);
    return false;
  }
}

// Create a visually distinct placeholder for testing
function createDistinctPlaceholder(outputPath, slideNumber, title) {
  try {
    let placeholderText;
    
    if (slideNumber % 2 === 0) {
      placeholderText = `SLIDE ${slideNumber} - EVEN NUMBER\n\nThis is an even-numbered slide placeholder.\nTitle: ${title}\n\nSlide content would appear here.`;
    } else {
      placeholderText = `SLIDE ${slideNumber} - ODD NUMBER\n\nThis is an odd-numbered slide placeholder.\nTitle: ${title}\n\nDifferent slide content would appear here.`;
    }
    
    fs.writeFileSync(outputPath, placeholderText);
    console.log(`Created distinct placeholder for slide ${slideNumber}`);
    return true;
  } catch (error) {
    console.error(`Error creating distinct placeholder: ${error.message}`);
    return false;
  }
}

// Serve static files from the public directory
app.use('/slides', express.static(path.join(__dirname, 'public', 'slides')));
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/', (req, res) => {
  res.send('PowerPoint Conversion Server is running');
});

// Upload and convert PowerPoint endpoint
app.post('/convert', upload.single('presentation'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  console.log(`Received file: ${req.file.originalname} (${req.file.size} bytes)`);
  
  const inputFile = req.file.path;
  const presentationId = uuidv4();
  const outputDir = path.join(__dirname, 'public', 'slides', presentationId);
  
  // Get metadata from request body
  const title = req.body.title || req.file.originalname.replace(/\.[^/.]+$/, "");
  const summary = req.body.summary || "";
  const author = req.body.author || "Anonymous";
  const authorId = req.body.authorId || uuidv4();
  const topics = req.body.topics ? (Array.isArray(req.body.topics) ? req.body.topics : [req.body.topics]) : [];
  
  // Initialize presentation data object
  const presentation = {
    id: presentationId,
    originalName: req.file.originalname,
    title: title,
    summary: summary,
    author: author,
    authorId: authorId,
    topics: topics,
    converted: new Date(),
    viewCount: 0
  };
  
  // Add presentation to topic indexes (memory cache)
  topics.forEach(topic => {
    topic = topic.toLowerCase();
    if (!presentationsByTopic[topic]) {
      presentationsByTopic[topic] = [];
    }
    presentationsByTopic[topic].push(presentationId);
  });
  
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Check if LibreOffice is installed
  const libreOfficeInstalled = checkLibreOfficeInstallation();
  
  if (!libreOfficeInstalled) {
    console.log('LibreOffice not found. Creating placeholder images...');
    
    // Try to install LibreOffice
    try {
      console.log('Attempting to install LibreOffice...');
      execSync('apt-get update && apt-get install -y libreoffice poppler-utils imagemagick', { stdio: 'inherit' });
      console.log('LibreOffice installation completed. Retrying conversion...');
      
      // Check if installation succeeded
      const installSucceeded = checkLibreOfficeInstallation();
      if (!installSucceeded) {
        throw new Error('LibreOffice still not available after installation attempt');
      }
    } catch (installError) {
      console.error('Failed to install LibreOffice:', installError.message);
      
      // Create placeholder slides as fallback
      const placeholderCount = 5;
      const placeholderUrls = [];
      const slideTexts = [];
      
      for (let i = 0; i < placeholderCount; i++) {
        const placeholderPath = path.join(outputDir, `slide-${i+1}.jpg`);
        createPlaceholderImage(placeholderPath, i+1, req.file.originalname);
        placeholderUrls.push(`/slides/${presentationId}/slide-${i+1}.jpg`);
        slideTexts.push(`Slide ${i+1} (Placeholder)`);
      }
      
      // Update presentation with placeholder data
      presentation.slides = placeholderUrls;
      presentation.slideCount = placeholderCount;
      presentation.slideTexts = slideTexts;
      presentation.isPlaceholder = true;
      
      // Save to memory cache
      presentations[presentationId] = presentation;
      
      // Save to MongoDB
      const presentationDoc = new Presentation(presentation);
      presentationDoc.save()
        .then(() => {
          console.log(`Placeholder presentation ${presentationId} saved to database`);
        })
        .catch(err => {
          console.error(`Error saving placeholder presentation to database: ${err}`);
        });
      
      // Return the placeholder slides
      return res.json({
        id: presentationId,
        originalName: req.file.originalname,
        title: title,
        slideCount: placeholderCount,
        slides: placeholderUrls,
        slideTexts: slideTexts,
        status: "placeholders_created",
        message: "LibreOffice is not available. Generated placeholder slides instead.",
        topics: topics
      });
    }
  }
  
  console.log(`Converting PowerPoint to JPG images in ${outputDir}`);
  
  // Try to install PDF utilities if not already installed
  try {
    console.log('Installing PDF utilities...');
    execSync('apt-get update && apt-get install -y poppler-utils imagemagick', { stdio: 'inherit' });
    console.log('PDF utilities installation completed.');
  } catch (error) {
    console.error('Failed to install PDF utilities:', error.message);
  }
  
  // First, convert to PDF which should preserve all slides
  const pdfCmd = `libreoffice --headless --convert-to pdf --outdir ${outputDir} ${inputFile}`;
  console.log(`Executing PDF conversion: ${pdfCmd}`);
  
  exec(pdfCmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`PDF conversion error: ${error.message}`);
      fallbackToJpgConversion();
      return;
    }
    
    console.log(`PDF conversion output: ${stdout}`);
    
    // Check if PDF was created
    fs.readdir(outputDir, (err, files) => {
      if (err) {
        console.error(`Error reading output directory: ${err.message}`);
        fallbackToJpgConversion();
        return;
      }
      
      // Find PDF files
      const pdfFiles = files.filter(file => file.endsWith('.pdf'));
      
      if (pdfFiles.length === 0) {
        console.log('No PDF files were generated. Falling back to JPG conversion...');
        fallbackToJpgConversion();
        return;
      }
      
      // Process the PDF file to extract slides
      const pdfPath = path.join(outputDir, pdfFiles[0]);
      
      try {
        // Get PDF info including page count
        const pdfInfoCmd = `pdfinfo "${pdfPath}" | grep "Pages:" || echo "Pages: 0"`;
        const pdfInfoOutput = execSync(pdfInfoCmd).toString();
        const pageCountMatch = pdfInfoOutput.match(/Pages:\s+(\d+)/);
        const pageCount = pageCountMatch ? parseInt(pageCountMatch[1]) : 0;
        
        console.log(`PDF has ${pageCount} pages`);
        
        if (pageCount > 0) {
          // Create directories for temporary files
          const tempDir = path.join(outputDir, 'temp');
          if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
          }
          
          // Create image for each page of the PDF
          const renamedImageUrls = [];
          const slideTexts = [];
          
          // Use pdftoppm to convert PDF pages to images
          for (let i = 0; i < pageCount; i++) {
            const pageNum = i + 1;
            const outputPrefix = path.join(tempDir, `slide-${pageNum}`);
            
            // Convert PDF page to JPG
            const convertCmd = `pdftoppm -jpeg -f ${pageNum} -singlefile "${pdfPath}" "${outputPrefix}"`;
            
            try {
              execSync(convertCmd);
              
              // Find the generated image
              const tempFile = `${outputPrefix}.jpg`;
              const finalFile = path.join(outputDir, `slide-${pageNum}.jpg`);
              
              if (fs.existsSync(tempFile)) {
                // Copy to final location
                fs.copyFileSync(tempFile, finalFile);
                renamedImageUrls.push(`/slides/${presentationId}/slide-${pageNum}.jpg`);
                
                // Extract text from this page if possible
                try {
                  const textCmd = `pdftotext -f ${pageNum} -l ${pageNum} "${pdfPath}" -`;
                  const pageText = execSync(textCmd).toString().trim();
                  slideTexts.push(pageText);
                } catch (textError) {
                  slideTexts.push(`Slide ${pageNum}`);
                }
              } else {
                // Create a placeholder for this slide
                createDistinctPlaceholder(finalFile, pageNum, `Page ${pageNum} of ${req.file.originalname}`);
                renamedImageUrls.push(`/slides/${presentationId}/slide-${pageNum}.jpg`);
                slideTexts.push(`Slide ${pageNum} (Placeholder)`);
              }
            } catch (extractError) {
              // Create a placeholder for this slide
              const finalFile = path.join(outputDir, `slide-${pageNum}.jpg`);
              createDistinctPlaceholder(finalFile, pageNum, `Page ${pageNum} of ${req.file.originalname}`);
              renamedImageUrls.push(`/slides/${presentationId}/slide-${pageNum}.jpg`);
              slideTexts.push(`Slide ${pageNum} (Error Placeholder)`);
            }
          }
          
          // Update presentation with slide data
          presentation.slides = renamedImageUrls;
          presentation.slideCount = renamedImageUrls.length;
          presentation.slideTexts = slideTexts;
          presentation.isPlaceholder = false;
          
          // Store in memory cache
          presentations[presentationId] = presentation;
          
          // Save to MongoDB
          const presentationDoc = new Presentation(presentation);
          presentationDoc.save()
            .then(() => {
              console.log(`Presentation ${presentationId} saved to database`);
            })
            .catch(err => {
              console.error(`Error saving presentation to database: ${err}`);
            });
          
          // Return presentation data
          res.json({
            id: presentationId,
            originalName: req.file.originalname,
            title: title,
            slideCount: renamedImageUrls.length,
            slides: renamedImageUrls,
            slideTexts: slideTexts,
            topics: topics,
            status: "success"
          });
          
          // Clean up temporary files
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch (cleanupError) {
            console.error(`Error cleaning up temp directory: ${cleanupError.message}`);
          }
          
          // Clean up the uploaded file
          fs.unlink(inputFile, (err) => {
            if (err) console.error(`Error deleting uploaded file: ${err.message}`);
          });
          
          return;
        } else {
          console.log('PDF has no pages. Falling back to JPG conversion...');
          fallbackToJpgConversion();
        }
      } catch (pdfError) {
        console.error(`Error processing PDF: ${pdfError.message}`);
        fallbackToJpgConversion();
      }
    });
  });
  
  // Fallback function for JPG conversion if PDF route fails
  function fallbackToJpgConversion() {
    console.log('Falling back to direct JPG conversion...');
    
    // Use LibreOffice to convert PowerPoint to JPG
    const cmd = `libreoffice --headless --convert-to jpg:"draw_jpg_Export" --outdir ${outputDir} ${inputFile}`;
    console.log(`Executing fallback command: ${cmd}`);
    
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`Conversion error: ${error.message}`);
        createFallbackPlaceholders();
        return;
      }
      
      console.log(`Conversion output: ${stdout}`);
      
      // Get the generated images
      fs.readdir(outputDir, (err, files) => {
        if (err) {
          console.error(`Error reading output directory: ${err.message}`);
          createFallbackPlaceholders();
          return;
        }
        
        // Filter for JPG files and sort them
        let imageFiles = files.filter(file => file.endsWith('.jpg'));
        console.log(`Found ${imageFiles.length} jpg files`);
        
        // If no images were generated, create placeholders
        if (imageFiles.length === 0) {
          console.log('No images were generated. Creating placeholders...');
          createFallbackPlaceholders();
          return;
        }
        
        // Rename files to match expected format (slide-1.jpg, slide-2.jpg, etc.)
        console.log(`Renaming ${imageFiles.length} slide images to standard format`);
        const renamedImageUrls = [];
        const slideTexts = [];
        
        imageFiles.forEach((file, index) => {
          const oldPath = path.join(outputDir, file);
          const newFileName = `slide-${index+1}.jpg`;
          const newPath = path.join(outputDir, newFileName);
          
          try {
            // Rename the file
            fs.renameSync(oldPath, newPath);
            renamedImageUrls.push(`/slides/${presentationId}/${newFileName}`);
            slideTexts.push(`Slide ${index+1}`);
          } catch (error) {
            console.error(`Error renaming file ${file}: ${error.message}`);
            // Use the original file as fallback
            renamedImageUrls.push(`/slides/${presentationId}/${file}`);
            slideTexts.push(`Slide ${index+1}`);
          }
        });
        
        // Add distinct placeholders for multi-slide presentations
        // if only one slide was converted
        if (imageFiles.length === 1) {
          console.log('Only one slide converted. Creating distinct placeholders...');
          
          // Use the estimated slide count from filename or default to 23
          const estimatedSlideCount = 23;
          
          // First slide already exists
          // Create remaining slides as distinct placeholders
          for (let i = 1; i < estimatedSlideCount; i++) {
            const slideNumber = i + 1;
            const newFileName = `slide-${slideNumber}.jpg`;
            const newPath = path.join(outputDir, newFileName);
            
            try {
              // Create a distinct placeholder for this slide
              createDistinctPlaceholder(newPath, slideNumber, req.file.originalname);
              renamedImageUrls.push(`/slides/${presentationId}/${newFileName}`);
              slideTexts.push(`Slide ${slideNumber} (Placeholder)`);
            } catch (error) {
              console.error(`Error creating slide ${slideNumber}: ${error.message}`);
            }
          }
        }
        
        // Update presentation with slide data
        presentation.slides = renamedImageUrls;
        presentation.slideCount = renamedImageUrls.length;
        presentation.slideTexts = slideTexts;
        presentation.isPlaceholder = false;
        
        // Store in memory cache
        presentations[presentationId] = presentation;
        
        // Save to MongoDB
        const presentationDoc = new Presentation(presentation);
        presentationDoc.save()
          .then(() => {
            console.log(`Fallback presentation ${presentationId} saved to database`);
          })
          .catch(err => {
            console.error(`Error saving fallback presentation to database: ${err}`);
          });
        
        // Return presentation data
        res.json({
          id: presentationId,
          originalName: req.file.originalname,
          title: title,
          slideCount: renamedImageUrls.length,
          slides: renamedImageUrls,
          slideTexts: slideTexts,
          topics: topics,
          status: "success"
        });
        
        // Clean up the uploaded file
        fs.unlink(inputFile, (err) => {
          if (err) console.error(`Error deleting uploaded file: ${err.message}`);
        });
      });
    });
  }
  
  // Helper function to create fallback placeholders
  function createFallbackPlaceholders() {
    const estimatedSlideCount = 23; // Default to 23 slides
    const placeholderUrls = [];
    const slideTexts = [];
    
    for (let i = 0; i < estimatedSlideCount; i++) {
      const slideNumber = i + 1;
      const placeholderPath = path.join(outputDir, `slide-${slideNumber}.jpg`);
      createDistinctPlaceholder(placeholderPath, slideNumber, req.file.originalname);
      placeholderUrls.push(`/slides/${presentationId}/slide-${slideNumber}.jpg`);
      slideTexts.push(`Slide ${slideNumber} (Placeholder)`);
    }
    
    // Update presentation with placeholder data
    presentation.slides = placeholderUrls;
    presentation.slideCount = estimatedSlideCount;
    presentation.slideTexts = slideTexts;
    presentation.isPlaceholder = true;
    
    // Save in memory cache
    presentations[presentationId] = presentation;
    
    // Save to MongoDB
    const presentationDoc = new Presentation(presentation);
    presentationDoc.save()
      .then(() => {
        console.log(`Fallback placeholders presentation ${presentationId} saved to database`);
      })
      .catch(err => {
        console.error(`Error saving fallback placeholders presentation to database: ${err}`);
      });
    
    // Return the placeholder slides
    res.json({
      id: presentationId,
      originalName: req.file.originalname,
      title: title,
      slideCount: estimatedSlideCount,
      slides: placeholderUrls,
      slideTexts: slideTexts,
      topics: topics,
      status: "fallback_placeholders",
      message: "Conversion failed. Generated distinct placeholder slides instead."
    });
    
    // Clean up the uploaded file
    fs.unlink(inputFile, (err) => {
      if (err) console.error(`Error deleting uploaded file: ${err.message}`);
    });
  }
});

// Simplified: Forward the metadata to the convert endpoint
app.post('/presentations', upload.single('presentation'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  app.handle({
    method: 'POST',
    url: '/convert',
    headers: req.headers,
    body: req.body,
    file: req.file
  }, res);
});

// Get presentation info endpoint
app.get('/presentation/:id', async (req, res) => {
  const presentationId = req.params.id;
  const userId = req.query.userId; // Optional user ID for tracking
  
  // First try to get from memory cache
  if (presentations[presentationId]) {
    // Track this view if userId is provided
    if (userId) {
      // Initialize user history if needed
      if (!userPresentationHistory[userId]) {
        userPresentationHistory[userId] = [];
      }
      
      // Add to history if not already there
      if (!userPresentationHistory[userId].includes(presentationId)) {
        userPresentationHistory[userId].push(presentationId);
      }
      
      // Increment view count in database
      Presentation.findOneAndUpdate(
        { id: presentationId },
        { $inc: { viewCount: 1 } }
      ).catch(err => {
        console.error(`Error updating view count in database: ${err}`);
      });
    }
    
    return res.json(presentations[presentationId]);
  }
  
  // If not in memory, try to get from database
  try {
    const dbPresentation = await Presentation.findOne({ id: presentationId, isDeleted: false });
    
    if (!dbPresentation) {
      return res.status(404).json({ error: 'Presentation not found' });
    }
    
    // Add to memory cache
    const presentation = dbPresentation.toObject();
    presentations[presentationId] = presentation;
    
    // Update topic indexes
    (presentation.topics || []).forEach(topic => {
      topic = topic.toLowerCase();
      if (!presentationsByTopic[topic]) {
        presentationsByTopic[topic] = [];
      }
      if (!presentationsByTopic[topic].includes(presentationId)) {
        presentationsByTopic[topic].push(presentationId);
      }
    });
    
    // Track this view
    if (userId) {
      // Update view count
      dbPresentation.viewCount = (dbPresentation.viewCount || 0) + 1;
      await dbPresentation.save();
      
      // Add to user history
      if (!userPresentationHistory[userId]) {
        userPresentationHistory[userId] = [];
      }
      if (!userPresentationHistory[userId].includes(presentationId)) {
        userPresentationHistory[userId].push(presentationId);
      }
    }
    
    return res.json(presentation);
  } catch (err) {
    console.error(`Error fetching presentation from database: ${err}`);
    return res.status(500).json({ error: 'Database error' });
  }
});

// Simplified slide redirection
app.get('/slides/:presentationId/:slideNumber', (req, res) => {
  const { presentationId, slideNumber } = req.params;
  const slideIndex = parseInt(slideNumber) - 1; // Convert to zero-based index
  
  // Try memory cache first
  if (presentations[presentationId]) {
    if (isNaN(slideIndex) || slideIndex < 0 || slideIndex >= presentations[presentationId].slideCount) {
      return res.status(404).json({ error: 'Slide not found' });
    }
    
    const slidePath = presentations[presentationId].slides[slideIndex];
    return res.redirect(slidePath); // Redirect to the actual image file
  }
  
  // If not in memory, try database
  Presentation.findOne({ id: presentationId, isDeleted: false })
    .then(presentation => {
      if (!presentation) {
        return res.status(404).json({ error: 'Presentation not found' });
      }
      
      if (isNaN(slideIndex) || slideIndex < 0 || slideIndex >= presentation.slideCount) {
        return res.status(404).json({ error: 'Slide not found' });
      }
      
      // Cache for future use
      presentations[presentationId] = presentation.toObject();
      
      const slidePath = presentation.slides[slideIndex];
      res.redirect(slidePath);
    })
    .catch(err => {
      console.error(`Error fetching slide: ${err}`);
      res.status(500).json({ error: 'Database error' });
    });
});

// Get list of presentations
app.get('/presentations', async (req, res) => {
  try {
    // Get presentations from database
    const dbPresentations = await Presentation.find(
      { isDeleted: false },
      'id originalName title summary author topics slideCount converted isPlaceholder viewCount'
    );
    
    const presentationList = dbPresentations.map(p => p.toObject());
    
    // Update memory cache
    presentationList.forEach(p => {
      presentations[p.id] = p;
      
      // Update topic indexes
      (p.topics || []).forEach(topic => {
        topic = topic.toLowerCase();
        if (!presentationsByTopic[topic]) {
          presentationsByTopic[topic] = [];
        }
        if (!presentationsByTopic[topic].includes(p.id)) {
          presentationsByTopic[topic].push(p.id);
        }
      });
    });
    
    res.json({ presentations: presentationList });
  } catch (err) {
    console.error(`Error getting presentations: ${err}`);
    
    // Fallback to memory cache if database fails
    const presentationList = Object.values(presentations).map(p => ({
      id: p.id,
      originalName: p.originalName,
      title: p.title || p.originalName,
      summary: p.summary || "",
      author: p.author || "Anonymous",
      topics: p.topics || [],
      slideCount: p.slideCount,
      converted: p.converted,
      isPlaceholder: p.isPlaceholder || false,
      viewCount: p.viewCount || 0
    }));
    
    res.json({ presentations: presentationList });
  }
});

// Update presentation endpoint
app.put('/presentation/:id', async (req, res) => {
  const presentationId = req.params.id;
  const { title, summary, author, topics } = req.body;
  
  try {
    // Update in database
    const updatedPresentation = await Presentation.findOneAndUpdate(
      { id: presentationId, isDeleted: false },
      {
        ...(title && { title }),
        ...(summary && { summary }),
        ...(author && { author }),
        ...(topics && { topics })
      },
      { new: true }
    );
    
    if (!updatedPresentation) {
      return res.status(404).json({ error: 'Presentation not found' });
    }
    
    // Update memory cache
    if (presentations[presentationId]) {
      presentations[presentationId] = {
        ...presentations[presentationId],
        ...(title && { title }),
        ...(summary && { summary }),
        ...(author && { author }),
        ...(topics && { topics })
      };
      
      console.log(`Updated presentation ${presentationId} in memory cache`);
    }
    
    // Update topic indexes if topics changed
    if (topics) {
      // Remove from old topic indexes
      Object.keys(presentationsByTopic).forEach(topic => {
        presentationsByTopic[topic] = presentationsByTopic[topic].filter(id => id !== presentationId);
      });
      
      // Add to new topic indexes
      topics.forEach(topic => {
        const topicLower = topic.toLowerCase();
        if (!presentationsByTopic[topicLower]) {
          presentationsByTopic[topicLower] = [];
        }
        if (!presentationsByTopic[topicLower].includes(presentationId)) {
          presentationsByTopic[topicLower].push(presentationId);
        }
      });
    }
    
    res.json({
      success: true,
      message: 'Presentation updated successfully',
      presentation: updatedPresentation.toObject()
    });
    
  } catch (err) {
    console.error(`Error updating presentation: ${err}`);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get presentations by topic
app.get('/presentations/topic/:topic', async (req, res) => {
  const topic = req.params.topic.toLowerCase();
  
  try {
    // Query database directly
    const dbPresentations = await Presentation.find({
      topics: { $elemMatch: { $regex: new RegExp(topic, 'i') } },
      isDeleted: false
    });
    
    if (dbPresentations.length > 0) {
      const topicPresentations = dbPresentations.map(p => p.toObject());
      
      // Update memory cache
      topicPresentations.forEach(pres => {
        presentations[pres.id] = pres;
        
        // Update topic indexes
        (pres.topics || []).forEach(t => {
          const normalizedTopic = t.toLowerCase();
          if (!presentationsByTopic[normalizedTopic]) {
            presentationsByTopic[normalizedTopic] = [];
          }
          if (!presentationsByTopic[normalizedTopic].includes(pres.id)) {
            presentationsByTopic[normalizedTopic].push(pres.id);
          }
        });
      });
      
      return res.json({ presentations: topicPresentations });
    }
    
    // If not found in database, check memory cache as fallback
    if (presentationsByTopic[topic] && presentationsByTopic[topic].length > 0) {
      const topicPresentations = presentationsByTopic[topic]
        .map(id => presentations[id])
        .filter(p => p !== undefined);
      
      return res.json({ presentations: topicPresentations });
    }
    
    // If not found anywhere
    return res.json({ presentations: [] });
  } catch (err) {
    console.error(`Error getting presentations by topic: ${err}`);
    
    // Fallback to memory cache if database fails
    if (presentationsByTopic[topic]) {
      const topicPresentations = presentationsByTopic[topic]
        .map(id => presentations[id])
        .filter(p => p !== undefined);
      
      return res.json({ presentations: topicPresentations });
    }
    
    res.json({ presentations: [] });
  }
});

// User-presentation interaction APIs
app.get('/user/:userId/seen/:presentationId', (req, res) => {
  const { userId, presentationId } = req.params;
  
  if (!userPresentationHistory[userId]) {
    return res.json({ seen: false });
  }
  
  const seen = userPresentationHistory[userId].includes(presentationId);
  res.json({ seen });
});

app.get('/user/:userId/unseen/:topic', async (req, res) => {
  const { userId, topic } = req.params;
  const topicLower = topic.toLowerCase();
  
  try {
    // Query database for presentations with this topic
    const dbPresentations = await Presentation.find({
      topics: { $elemMatch: { $regex: new RegExp(topicLower, 'i') } },
      isDeleted: false
    });
    
    if (dbPresentations.length > 0) {
      const seenPresentations = userPresentationHistory[userId] || [];
      const unseenDbPresentations = dbPresentations
        .filter(p => !seenPresentations.includes(p.id))
        .map(p => p.toObject());
      
      // Update memory cache
      unseenDbPresentations.forEach(pres => {
        presentations[pres.id] = pres;
        
        // Update topic indexes
        (pres.topics || []).forEach(t => {
          const normalizedTopic = t.toLowerCase();
          if (!presentationsByTopic[normalizedTopic]) {
            presentationsByTopic[normalizedTopic] = [];
          }
          if (!presentationsByTopic[normalizedTopic].includes(pres.id)) {
            presentationsByTopic[normalizedTopic].push(pres.id);
          }
        });
      });
      
      return res.json({ presentations: unseenDbPresentations });
    }
    
    // Fallback to memory cache
    if (presentationsByTopic[topicLower]) {
      const seenPresentations = userPresentationHistory[userId] || [];
      const unseenPresentations = presentationsByTopic[topicLower]
        .filter(id => !seenPresentations.includes(id))
        .map(id => presentations[id])
        .filter(p => p !== undefined);
      
      return res.json({ presentations: unseenPresentations });
    }
    
    return res.json({ presentations: [] });
  } catch (err) {
    console.error(`Error getting unseen presentations: ${err}`);
    
    // Fallback to memory cache if database fails
    if (presentationsByTopic[topicLower]) {
      const seenPresentations = userPresentationHistory[userId] || [];
      const unseenPresentations = presentationsByTopic[topicLower]
        .filter(id => !seenPresentations.includes(id))
        .map(id => presentations[id])
        .filter(p => p !== undefined);
      
      return res.json({ presentations: unseenPresentations });
    }
    
    res.json({ presentations: [] });
  }
});

app.post('/user/:userId/seen/:presentationId', (req, res) => {
  const { userId, presentationId } = req.params;
  
  if (!userPresentationHistory[userId]) {
    userPresentationHistory[userId] = [];
  }
  
  if (!userPresentationHistory[userId].includes(presentationId)) {
    userPresentationHistory[userId].push(presentationId);
  }
  
  res.json({ success: true });
});

// Delete presentation endpoint (soft delete)
app.delete('/presentation/:id', async (req, res) => {
  const presentationId = req.params.id;
  
  try {
    // Mark as deleted in database
    const result = await Presentation.findOneAndUpdate(
      { id: presentationId, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );
    
    if (!result) {
      return res.status(404).json({ error: 'Presentation not found' });
    }
    
    // Remove from memory cache
    if (presentations[presentationId]) {
      // Remove from topic indexes
      const topics = presentations[presentationId].topics || [];
      topics.forEach(topic => {
        topic = topic.toLowerCase();
        if (presentationsByTopic[topic]) {
          presentationsByTopic[topic] = presentationsByTopic[topic].filter(id => id !== presentationId);
        }
      });
      
      delete presentations[presentationId];
    }
    
    // Remove from user history
    Object.keys(userPresentationHistory).forEach(userId => {
      userPresentationHistory[userId] = userPresentationHistory[userId].filter(id => id !== presentationId);
    });
    
    res.json({ success: true, message: 'Presentation deleted' });
  } catch (err) {
    console.error(`Error deleting presentation: ${err}`);
    
    // Fallback to memory-only delete if database fails
    if (presentations[presentationId]) {
      // Remove from topic indexes
      const topics = presentations[presentationId].topics || [];
      topics.forEach(topic => {
        topic = topic.toLowerCase();
        if (presentationsByTopic[topic]) {
          presentationsByTopic[topic] = presentationsByTopic[topic].filter(id => id !== presentationId);
        }
      });
      
      delete presentations[presentationId];
      
      // Remove from user history
      Object.keys(userPresentationHistory).forEach(userId => {
        userPresentationHistory[userId] = userPresentationHistory[userId].filter(id => id !== presentationId);
      });
      
      return res.json({
        success: true,
        message: 'Presentation deleted from memory cache, but database update failed'
      });
    }
    
    res.status(500).json({ error: 'Server error' });
  }
});

// Get topics list
app.get('/topics', async (req, res) => {
  try {
    // Get topics from database
    const topicAggregation = await Presentation.aggregate([
      { $match: { isDeleted: false } },
      { $unwind: "$topics" },
      { $group: { _id: { $toLower: "$topics" }, count: { $sum: 1 } } },
      { $project: { _id: 0, name: "$_id", count: 1 } },
      { $sort: { count: -1 } }
    ]);
    
    if (topicAggregation.length > 0) {
      return res.json({ topics: topicAggregation });
    }
    
    // Fallback to in-memory topics
    res.json({
      topics: Object.keys(presentationsByTopic).map(topic => ({
        name: topic,
        count: presentationsByTopic[topic].length
      }))
    });
  } catch (err) {
    console.error(`Error getting topics: ${err}`);
    
    // Fallback to in-memory topics
    res.json({
      topics: Object.keys(presentationsByTopic).map(topic => ({
        name: topic,
        count: presentationsByTopic[topic].length
      }))
    });
  }
});

// Database status endpoint - simplified for production use
app.get('/status', async (req, res) => {
  try {
    const dbStatus = {
      connected: mongoose.connection.readyState === 1,
      presentationCount: await Presentation.countDocuments({ isDeleted: false }),
      memoryPresentationCount: Object.keys(presentations).length,
      version: "1.5"
    };
    
    res.json(dbStatus);
  } catch (err) {
    res.status(500).json({
      error: 'Database error',
      message: err.message,
      connected: mongoose.connection.readyState === 1
    });
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Something went wrong!' });
});

// Initialize database connection and start server
mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('Connected to MongoDB database');
  
  // Load presentations from database on startup
  loadPresentationsFromDatabase();
  
  // Start the server
  app.listen(port, () => {
    console.log(`PowerPoint Conversion Server (v1.5 with MongoDB) running on port ${port}`);
    
    // Check if LibreOffice is installed
    const libreOfficeInstalled = checkLibreOfficeInstallation();
    if (!libreOfficeInstalled) {
      console.error('WARNING: LibreOffice is not installed. Conversion functionality will not work!');
      
      // Try to install LibreOffice and PDF utilities
      try {
        console.log('Attempting to install LibreOffice and PDF utilities on server startup...');
        execSync('apt-get update && apt-get install -y libreoffice poppler-utils imagemagick', { stdio: 'inherit' });
        console.log('Installation completed.');
      } catch (installError) {
        console.error('Failed to automatically install LibreOffice:', installError.message);
      }
    }
  });
}).catch(err => {
  console.error(`Failed to connect to MongoDB: ${err}`);
  console.warn('Running without database persistence. Presentations will be lost on restart!');
  
  // Start the server anyway, but without database functionality
  app.listen(port, () => {
    console.log(`PowerPoint Conversion Server (v1.5 fallback mode) running on port ${port}`);
  });
});
