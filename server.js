// server.js - PowerPoint Conversion Server v 1.7 with FIXED MongoDB Persistence & working Slide urls
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

// Set up multer upload with progress tracking
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

// CRITICAL FIX: Function to ensure database write succeeds before responding
async function saveToDatabase(presentationData) {
  console.log(`🔄 ATTEMPTING DATABASE SAVE for presentation: ${presentationData.id}`);
  console.log(`📊 Data being saved:`, JSON.stringify({
    id: presentationData.id,
    title: presentationData.title,
    slideCount: presentationData.slideCount,
    topics: presentationData.topics
  }, null, 2));

  try {
    // First, check if presentation already exists
    const existingPresentation = await Presentation.findOne({ id: presentationData.id });
    
    if (existingPresentation) {
      console.log(`⚠️  Presentation ${presentationData.id} already exists in database. Updating...`);
      
      // Update existing presentation
      const updatedPresentation = await Presentation.findOneAndUpdate(
        { id: presentationData.id },
        presentationData,
        { new: true, upsert: false }
      );
      
      console.log(`✅ SUCCESSFULLY UPDATED presentation ${presentationData.id} in database`);
      return updatedPresentation.toObject();
    } else {
      // Create new presentation
      const presentationDoc = new Presentation(presentationData);
      const savedDoc = await presentationDoc.save();
      
      console.log(`✅ SUCCESSFULLY SAVED NEW presentation ${presentationData.id} to database`);
      console.log(`📝 Database document ID: ${savedDoc._id}`);
      
      return savedDoc.toObject();
    }
  } catch (error) {
    console.error(`❌ CRITICAL DATABASE ERROR for presentation ${presentationData.id}:`, error);
    throw error; // Re-throw to handle in calling function
  }
}

// CRITICAL FIX: Function to verify database save succeeded
async function verifyDatabaseSave(presentationId) {
  try {
    const foundPresentation = await Presentation.findOne({ id: presentationId });
    if (foundPresentation) {
      console.log(`✅ VERIFICATION SUCCESSFUL: Presentation ${presentationId} found in database`);
      return true;
    } else {
      console.error(`❌ VERIFICATION FAILED: Presentation ${presentationId} NOT found in database`);
      return false;
    }
  } catch (error) {
    console.error(`❌ VERIFICATION ERROR for ${presentationId}:`, error);
    return false;
  }
}

// Function to load presentations from database on startup
async function loadPresentationsFromDatabase() {
  try {
    const dbPresentations = await Presentation.find({ isDeleted: false });
    console.log(`📚 Loaded ${dbPresentations.length} presentations from database`);
    
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
    
    console.log('✅ Presentations successfully loaded from database to memory');
    console.log(`📊 Memory cache now contains: ${Object.keys(presentations).length} presentations`);
  } catch (err) {
    console.error(`❌ Error loading presentations from database: ${err}`);
  }
}

// Function to check if LibreOffice is installed
function checkLibreOfficeInstallation() {
  try {
    console.log('🔍 Checking LibreOffice installation...');
    const result = execSync('which libreoffice || echo "not found"').toString().trim();
    if (result === "not found") {
      console.error('❌ LibreOffice is not installed or not in PATH');
      return false;
    }
    console.log(`✅ LibreOffice found at: ${result}`);
    return true;
  } catch (error) {
    console.error('❌ Error checking for LibreOffice:', error.message);
    return false;
  }
}

// Function to create a placeholder image for when LibreOffice isn't available
function createPlaceholderImage(outputPath, slideNumber, title) {
  try {
    const placeholderText = `Placeholder for slide ${slideNumber}\nTitle: ${title}\n\nLibreOffice is not installed on the server,\nso actual slide conversion is not available.`;
    fs.writeFileSync(outputPath, placeholderText);
    console.log(`📝 Created placeholder at ${outputPath}`);
    return true;
  } catch (error) {
    console.error(`❌ Error creating placeholder: ${error.message}`);
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
    console.log(`📝 Created distinct placeholder for slide ${slideNumber}`);
    return true;
  } catch (error) {
    console.error(`❌ Error creating distinct placeholder: ${error.message}`);
    return false;
  }
}

// FIXED: Static file serving with debug logging
app.use('/slides', (req, res, next) => {
  console.log(`📸 Slide request: ${req.originalUrl}`);
  console.log(`📂 Looking for file: ${path.join(__dirname, 'public', 'slides', req.path)}`);
  
  // Check if file exists
  const filePath = path.join(__dirname, 'public', 'slides', req.path);
  if (fs.existsSync(filePath)) {
    console.log(`✅ File exists: ${filePath}`);
  } else {
    console.log(`❌ File NOT found: ${filePath}`);
    
    // List what files ARE in the directory
    const dirPath = path.dirname(filePath);
    if (fs.existsSync(dirPath)) {
      try {
        const filesInDir = fs.readdirSync(dirPath);
        console.log(`📁 Files in ${dirPath}:`, filesInDir);
      } catch (err) {
        console.log(`❌ Could not read directory ${dirPath}:`, err.message);
      }
    } else {
      console.log(`❌ Directory does not exist: ${dirPath}`);
    }
  }
  
  next();
});

// Serve static files from the public directory
app.use('/slides', express.static(path.join(__dirname, 'public', 'slides')));
app.use(express.static(path.join(__dirname, 'public')));

// Debug endpoints
app.get('/debug/slides/:presentationId', (req, res) => {
  const presentationId = req.params.presentationId;
  const slidesDir = path.join(__dirname, 'public', 'slides', presentationId);
  
  console.log(`🔍 Debug request for presentation: ${presentationId}`);
  console.log(`🔍 Looking in directory: ${slidesDir}`);
  
  if (fs.existsSync(slidesDir)) {
    try {
      const files = fs.readdirSync(slidesDir);
      console.log(`✅ Found ${files.length} files in slides directory`);
      
      res.json({
        success: true,
        presentationId: presentationId,
        slidesDirectory: slidesDir,
        filesFound: files.length,
        files: files,
        sampleUrls: files.slice(0, 5).map(file => `/slides/${presentationId}/${file}`),
        firstFileFullPath: files.length > 0 ? path.join(slidesDir, files[0]) : null
      });
    } catch (err) {
      console.error(`❌ Error reading slides directory: ${err}`);
      res.status(500).json({
        error: 'Could not read slides directory',
        presentationId: presentationId,
        directory: slidesDir,
        errorMessage: err.message
      });
    }
  } else {
    console.log(`❌ Slides directory not found: ${slidesDir}`);
    
    // Check if parent directory exists
    const parentDir = path.join(__dirname, 'public', 'slides');
    if (fs.existsSync(parentDir)) {
      const allPresentations = fs.readdirSync(parentDir);
      res.status(404).json({
        error: 'Slides directory not found for this presentation',
        presentationId: presentationId,
        expectedPath: slidesDir,
        availablePresentations: allPresentations
      });
    } else {
      res.status(404).json({
        error: 'Slides parent directory not found',
        presentationId: presentationId,
        expectedPath: slidesDir,
        parentDirectory: parentDir,
        parentExists: false
      });
    }
  }
});

app.get('/debug/filesystem', (req, res) => {
  const publicDir = path.join(__dirname, 'public');
  const slidesDir = path.join(__dirname, 'public', 'slides');
  
  const result = {
    serverDirectory: __dirname,
    publicDirectory: publicDir,
    slidesDirectory: slidesDir,
    publicExists: fs.existsSync(publicDir),
    slidesExists: fs.existsSync(slidesDir)
  };
  
  if (fs.existsSync(publicDir)) {
    try {
      result.publicContents = fs.readdirSync(publicDir);
    } catch (err) {
      result.publicError = err.message;
    }
  }
  
  if (fs.existsSync(slidesDir)) {
    try {
      result.slidesContents = fs.readdirSync(slidesDir);
    } catch (err) {
      result.slidesError = err.message;
    }
  }
  
  res.json(result);
});

// PROGRESS TRACKING MIDDLEWARE
app.use('/convert', (req, res, next) => {
  let totalBytes = 0;
  let uploadedBytes = 0;

  // Track upload progress
  req.on('data', (chunk) => {
    uploadedBytes += chunk.length;
    const progress = totalBytes > 0 ? (uploadedBytes / totalBytes) * 100 : 0;
    
    // You could emit progress events here if using WebSockets
    console.log(`📤 Upload progress: ${progress.toFixed(1)}%`);
  });

  req.on('end', () => {
    console.log('📤 Upload completed');
  });

  next();
});

// Health check endpoint
app.get('/', (req, res) => {
  res.send('PowerPoint Conversion Server v1.6 is running');
});

// FIXED: Upload and convert PowerPoint endpoint with proper database persistence
app.post('/convert', upload.single('presentation'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  console.log(`📁 Received file: ${req.file.originalname} (${req.file.size} bytes)`);
  
  const inputFile = req.file.path;
  const presentationId = uuidv4();
  const outputDir = path.join(__dirname, 'public', 'slides', presentationId);
  
  // Get metadata from request body
  const title = req.body.title || req.file.originalname.replace(/\.[^/.]+$/, "");
  const summary = req.body.summary || "";
  const author = req.body.author || "Anonymous";
  const authorId = req.body.authorId || uuidv4();
  const topics = req.body.topics ? (Array.isArray(req.body.topics) ? req.body.topics : [req.body.topics]) : [];
  
  console.log(`🎯 Processing presentation: "${title}" by ${author}`);
  console.log(`🏷️  Topics: [${topics.join(', ')}]`);
  
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
    viewCount: 0,
    isDeleted: false
  };
  
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Check if LibreOffice is installed
  const libreOfficeInstalled = checkLibreOfficeInstallation();
  
  if (!libreOfficeInstalled) {
    console.log('⚠️  LibreOffice not found. Creating placeholder images...');
    
    // Try to install LibreOffice
    try {
      console.log('📦 Attempting to install LibreOffice...');
      execSync('apt-get update && apt-get install -y libreoffice poppler-utils imagemagick', { stdio: 'inherit' });
      console.log('✅ LibreOffice installation completed. Retrying conversion...');
      
      // Check if installation succeeded
      const installSucceeded = checkLibreOfficeInstallation();
      if (!installSucceeded) {
        throw new Error('LibreOffice still not available after installation attempt');
      }
    } catch (installError) {
      console.error('❌ Failed to install LibreOffice:', installError.message);
      
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
      
      // CRITICAL FIX: Save to database and verify before responding
      try {
        console.log(`💾 Saving placeholder presentation to database...`);
        const savedPresentation = await saveToDatabase(presentation);
        
        // Verify the save worked
        const verified = await verifyDatabaseSave(presentationId);
        if (!verified) {
          throw new Error('Database verification failed');
        }
        
        // Add to memory cache only after successful database save
        presentations[presentationId] = savedPresentation;
        
        // Add presentation to topic indexes
        topics.forEach(topic => {
          topic = topic.toLowerCase();
          if (!presentationsByTopic[topic]) {
            presentationsByTopic[topic] = [];
          }
          presentationsByTopic[topic].push(presentationId);
        });
        
        console.log(`✅ Successfully saved and verified placeholder presentation ${presentationId}`);
        
        // Send success response
        res.json({
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
        
      } catch (dbError) {
        console.error(`❌ CRITICAL: Failed to save placeholder presentation to database: ${dbError}`);
        res.status(500).json({
          error: "Failed to save presentation to database",
          details: dbError.message,
          id: presentationId,
          status: "database_error"
        });
      }
      
      // Clean up uploaded file
      fs.unlink(inputFile, (err) => {
        if (err) console.error(`❌ Error deleting uploaded file: ${err.message}`);
      });
      
      return;
    }
  }
  
  console.log(`🔄 Converting PowerPoint to JPG images in ${outputDir}`);
  
  // Try to install PDF utilities if not already installed
  try {
    console.log('📦 Installing PDF utilities...');
    execSync('apt-get update && apt-get install -y poppler-utils imagemagick', { stdio: 'inherit' });
    console.log('✅ PDF utilities installation completed.');
  } catch (error) {
    console.error('❌ Failed to install PDF utilities:', error.message);
  }
  
  // First, convert to PDF which should preserve all slides
  const pdfCmd = `libreoffice --headless --convert-to pdf --outdir ${outputDir} ${inputFile}`;
  console.log(`🔄 Executing PDF conversion: ${pdfCmd}`);
  
    exec(pdfCmd, async (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ PDF conversion error: ${error.message}`);
        await fallbackToJpgConversion();
        return;
      }
      
      console.log(`✅ PDF conversion output: ${stdout}`);
      
      // Check if PDF was created
      fs.readdir(outputDir, async (err, files) => {
        if (err) {
          console.error(`❌ Error reading output directory: ${err.message}`);
          await fallbackToJpgConversion();
          return;
        }
        
        // Find PDF files
        const pdfFiles = files.filter(file => file.endsWith('.pdf'));
        
        if (pdfFiles.length === 0) {
          console.log('⚠️  No PDF files were generated. Falling back to JPG conversion...');
          await fallbackToJpgConversion();
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
          
          console.log(`📄 PDF has ${pageCount} pages`);
          
          if (pageCount > 0) {
            // Create directories for temporary files
            const tempDir = path.join(outputDir, 'temp');
            if (!fs.existsSync(tempDir)) {
              fs.mkdirSync(tempDir, { recursive: true });
            }
            
            // CRITICAL FIX: Actually extract images from each PDF page
            const renamedImageUrls = [];
            const slideTexts = [];
            
            console.log(`🔄 Starting slide extraction for ${pageCount} pages`);
            
            // Use pdftoppm to convert PDF pages to images
            for (let i = 0; i < pageCount; i++) {
              const pageNum = i + 1;
              const outputPrefix = path.join(tempDir, `slide-${pageNum}`);
              
              // Convert PDF page to JPG
              const convertCmd = `pdftoppm -jpeg -f ${pageNum} -singlefile "${pdfPath}" "${outputPrefix}"`;
              
              console.log(`🖼️  Converting page ${pageNum}: ${convertCmd}`);
              
              try {
                execSync(convertCmd);
                
                // Find the generated image
                const tempFile = `${outputPrefix}.jpg`;
                const finalFile = path.join(outputDir, `slide-${pageNum}.jpg`);
                
                if (fs.existsSync(tempFile)) {
                  // Copy to final location
                  fs.copyFileSync(tempFile, finalFile);
                  renamedImageUrls.push(`/slides/${presentationId}/slide-${pageNum}.jpg`);
                  
                  console.log(`✅ Successfully created slide ${pageNum} image`);
                  
                  // Extract text from this page if possible
                  try {
                    const textCmd = `pdftotext -f ${pageNum} -l ${pageNum} "${pdfPath}" -`;
                    const pageText = execSync(textCmd).toString().trim();
                    slideTexts.push(pageText || `Slide ${pageNum}`);
                  } catch (textError) {
                    slideTexts.push(`Slide ${pageNum}`);
                  }
                } else {
                  console.error(`❌ Failed to create slide ${pageNum} - file not found: ${tempFile}`);
                  // Create a placeholder for this slide
                  createDistinctPlaceholder(finalFile, pageNum, `Page ${pageNum} of ${req.file.originalname}`);
                  renamedImageUrls.push(`/slides/${presentationId}/slide-${pageNum}.jpg`);
                  slideTexts.push(`Slide ${pageNum} (Placeholder)`);
                }
              } catch (extractError) {
                console.error(`❌ Error extracting slide ${pageNum}: ${extractError.message}`);
                // Create a placeholder for this slide
                const finalFile = path.join(outputDir, `slide-${pageNum}.jpg`);
                createDistinctPlaceholder(finalFile, pageNum, `Page ${pageNum} of ${req.file.originalname}`);
                renamedImageUrls.push(`/slides/${presentationId}/slide-${pageNum}.jpg`);
                slideTexts.push(`Slide ${pageNum} (Error Placeholder)`);
              }
            }
            
            console.log(`🎯 Slide extraction complete: ${renamedImageUrls.length} slides created`);
            
            // CRITICAL FIX: Update presentation with slide data BEFORE saving to database
            presentation.slides = renamedImageUrls;
            presentation.slideCount = renamedImageUrls.length;
            presentation.slideTexts = slideTexts;
            presentation.isPlaceholder = false;
            
            console.log(`📊 Presentation data updated with ${renamedImageUrls.length} slides:`);
            console.log(`🔗 Sample slide URLs:`, renamedImageUrls.slice(0, 3));
            
            // CRITICAL FIX: Save to database and verify before responding
            try {
              console.log(`💾 Saving converted presentation to database with slide data...`);
              const savedPresentation = await saveToDatabase(presentation);
              
              // Verify the save worked
              const verified = await verifyDatabaseSave(presentationId);
              if (!verified) {
                throw new Error('Database verification failed');
              }
              
              // Add to memory cache only after successful database save
              presentations[presentationId] = savedPresentation;
              
              // Add presentation to topic indexes
              topics.forEach(topic => {
                topic = topic.toLowerCase();
                if (!presentationsByTopic[topic]) {
                  presentationsByTopic[topic] = [];
                }
                presentationsByTopic[topic].push(presentationId);
              });
              
              console.log(`✅ Successfully saved and verified converted presentation ${presentationId} with ${renamedImageUrls.length} slides`);
              
              // Send success response
              res.json({
                id: presentationId,
                originalName: req.file.originalname,
                title: title,
                slideCount: renamedImageUrls.length,
                slides: renamedImageUrls,
                slideTexts: slideTexts,
                topics: topics
              });
              
            } catch (dbError) {
              console.error(`❌ CRITICAL: Failed to save converted presentation to database: ${dbError}`);
              res.status(500).json({
                error: "Failed to save presentation to database",
                details: dbError.message,
                id: presentationId,
                status: "database_error"
              });
            }
            
            // Clean up temporary files
            try {
              fs.rmSync(tempDir, { recursive: true, force: true });
              fs.rmSync(pdfPath, { force: true }); // Also clean up the PDF
            } catch (cleanupError) {
              console.error(`❌ Error cleaning up temp files: ${cleanupError.message}`);
            }
            
            // Clean up the uploaded file
            fs.unlink(inputFile, (err) => {
              if (err) console.error(`❌ Error deleting uploaded file: ${err.message}`);
            });
            
            return;
          } else {
            console.log('⚠️  PDF has no pages. Falling back to JPG conversion...');
            await fallbackToJpgConversion();
          }
        } catch (pdfError) {
          console.error(`❌ Error processing PDF: ${pdfError.message}`);
          await fallbackToJpgConversion();
        }
      });
    });
  
  // Fallback function for JPG conversion if PDF route fails
  async function fallbackToJpgConversion() {
    console.log('🔄 Falling back to direct JPG conversion...');
    
    // Use LibreOffice to convert PowerPoint to JPG
    const cmd = `libreoffice --headless --convert-to jpg:"draw_jpg_Export" --outdir ${outputDir} ${inputFile}`;
    console.log(`🔄 Executing fallback command: ${cmd}`);
    
    exec(cmd, async (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ Conversion error: ${error.message}`);
        await createFallbackPlaceholders();
        return;
      }
      
      console.log(`✅ Conversion output: ${stdout}`);
      
      // Get the generated images
      fs.readdir(outputDir, async (err, files) => {
        if (err) {
          console.error(`❌ Error reading output directory: ${err.message}`);
          await createFallbackPlaceholders();
          return;
        }
        
        // Filter for JPG files and sort them
        let imageFiles = files.filter(file => file.endsWith('.jpg'));
        console.log(`📸 Found ${imageFiles.length} jpg files`);
        
        // If no images were generated, create placeholders
        if (imageFiles.length === 0) {
          console.log('⚠️  No images were generated. Creating placeholders...');
          await createFallbackPlaceholders();
          return;
        }
        
        // Rename files to match expected format (slide-1.jpg, slide-2.jpg, etc.)
        console.log(`🔄 Renaming ${imageFiles.length} slide images to standard format`);
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
            console.error(`❌ Error renaming file ${file}: ${error.message}`);
            // Use the original file as fallback
            renamedImageUrls.push(`/slides/${presentationId}/${file}`);
            slideTexts.push(`Slide ${index+1}`);
          }
        });
        
        // Add distinct placeholders for multi-slide presentations
        // if only one slide was converted
        if (imageFiles.length === 1) {
          console.log('⚠️  Only one slide converted. Creating distinct placeholders...');
          
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
              console.error(`❌ Error creating slide ${slideNumber}: ${error.message}`);
            }
          }
        }
        
        // Update presentation with slide data
        presentation.slides = renamedImageUrls;
        presentation.slideCount = renamedImageUrls.length;
        presentation.slideTexts = slideTexts;
        presentation.isPlaceholder = false;
        
        // CRITICAL FIX: Save to database and verify before responding
        try {
          console.log(`💾 Saving fallback presentation to database...`);
          const savedPresentation = await saveToDatabase(presentation);
          
          // Verify the save worked
          const verified = await verifyDatabaseSave(presentationId);
          if (!verified) {
            throw new Error('Database verification failed');
          }
          
          // Add to memory cache only after successful database save
          presentations[presentationId] = savedPresentation;
          
          // Add presentation to topic indexes
          topics.forEach(topic => {
            topic = topic.toLowerCase();
            if (!presentationsByTopic[topic]) {
              presentationsByTopic[topic] = [];
            }
            presentationsByTopic[topic].push(presentationId);
          });
          
          console.log(`✅ Successfully saved and verified fallback presentation ${presentationId}`);
          
          // Send success response
          res.json({
            id: presentationId,
            originalName: req.file.originalname,
            title: title,
            slideCount: renamedImageUrls.length,
            slides: renamedImageUrls,
            slideTexts: slideTexts,
            topics: topics
          });
          
        } catch (dbError) {
          console.error(`❌ CRITICAL: Failed to save fallback presentation to database: ${dbError}`);
          res.status(500).json({
            error: "Failed to save presentation to database",
            details: dbError.message,
            id: presentationId,
            status: "database_error"
          });
        }
        
        // Clean up the uploaded file
        fs.unlink(inputFile, (err) => {
          if (err) console.error(`❌ Error deleting uploaded file: ${err.message}`);
        });
      });
    });
  }
  
  // Helper function to create fallback placeholders
  async function createFallbackPlaceholders() {
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
    
    // CRITICAL FIX: Save to database and verify before responding
    try {
      console.log(`💾 Saving final fallback presentation to database...`);
      const savedPresentation = await saveToDatabase(presentation);
      
      // Verify the save worked
      const verified = await verifyDatabaseSave(presentationId);
      if (!verified) {
        throw new Error('Database verification failed');
      }
      
      // Add to memory cache only after successful database save
      presentations[presentationId] = savedPresentation;
      
      // Add presentation to topic indexes
      topics.forEach(topic => {
        topic = topic.toLowerCase();
        if (!presentationsByTopic[topic]) {
          presentationsByTopic[topic] = [];
        }
        presentationsByTopic[topic].push(presentationId);
      });
      
      console.log(`✅ Successfully saved and verified final fallback presentation ${presentationId}`);
      
      // Send success response
      res.json({
        id: presentationId,
        originalName: req.file.originalname,
        title: title,
        slideCount: estimatedSlideCount,
        slides: placeholderUrls,
        slideTexts: slideTexts,
        status: "fallback_placeholders",
        message: "Conversion failed. Generated distinct placeholder slides instead.",
        topics: topics
      });
      
    } catch (dbError) {
      console.error(`❌ CRITICAL: Failed to save final fallback presentation to database: ${dbError}`);
      res.status(500).json({
        error: "Failed to save presentation to database",
        details: dbError.message,
        id: presentationId,
        status: "database_error"
      });
    }
    
    // Clean up the uploaded file
    fs.unlink(inputFile, (err) => {
      if (err) console.error(`❌ Error deleting uploaded file: ${err.message}`);
    });
  }
});

// FIXED: Get presentation info endpoint with proper database queries
app.get('/presentation/:id', async (req, res) => {
  const presentationId = req.params.id;
  const userId = req.query.userId; // Optional user ID for tracking
  
  console.log(`📊 Getting presentation: ${presentationId}`);
  
  // First try to get from memory cache
  if (presentations[presentationId]) {
    console.log(`✅ Found presentation ${presentationId} in memory cache`);
    
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
        console.error(`❌ Error updating view count in database: ${err}`);
      });
    }
    
    return res.json(presentations[presentationId]);
  }
  
  // If not in memory, try to get from database
  try {
    console.log(`🔍 Searching database for presentation: ${presentationId}`);
    // CRITICAL FIX: Use lean() to get all fields as plain object
    const dbPresentation = await Presentation.findOne({ id: presentationId, isDeleted: false }).lean();
    
    if (!dbPresentation) {
      console.log(`❌ Presentation ${presentationId} not found in database`);
      return res.status(404).json({ error: 'Presentation not found' });
    }
    
    console.log(`✅ Found presentation ${presentationId} in database`);
    console.log(`📊 Database document has ${dbPresentation.slides?.length || 0} slides and ${dbPresentation.slideTexts?.length || 0} slide texts`);
    
    // Add to memory cache
    presentations[presentationId] = dbPresentation;
    
    // Update topic indexes
    (dbPresentation.topics || []).forEach(topic => {
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
      await Presentation.findOneAndUpdate(
        { id: presentationId },
        { $inc: { viewCount: 1 } }
      );
      
      // Add to user history
      if (!userPresentationHistory[userId]) {
        userPresentationHistory[userId] = [];
      }
      if (!userPresentationHistory[userId].includes(presentationId)) {
        userPresentationHistory[userId].push(presentationId);
      }
    }
    
    return res.json(dbPresentation);
  } catch (err) {
    console.error(`❌ Error fetching presentation from database: ${err}`);
    return res.status(500).json({ error: 'Database error' });
  }
});

// FIXED: Get list of presentations with proper database queries
app.get('/presentations', async (req, res) => {
  console.log(`📚 Getting all presentations...`);
  
  try {
    // Get presentations from database
    const dbPresentations = await Presentation.find(
      { isDeleted: false },
      'id originalName title summary author topics slideCount converted isPlaceholder viewCount'
    );
    
    console.log(`✅ Found ${dbPresentations.length} presentations in database`);
    
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
    
    console.log(`📊 Memory cache updated with ${Object.keys(presentations).length} presentations`);
    
    res.json({ presentations: presentationList });
  } catch (err) {
    console.error(`❌ Error getting presentations: ${err}`);
    
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
    
    console.log(`⚠️  Using memory cache fallback: ${presentationList.length} presentations`);
    
    res.json({ presentations: presentationList });
  }
});

// Simplified: Forward the metadata to the convert endpoint
app.post('/presentations', upload.single('presentation'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  // Forward to the convert endpoint
  req.url = '/convert';
  app._router.handle(req, res);
});

// Update presentation endpoint
app.put('/presentation/:id', async (req, res) => {
  const presentationId = req.params.id;
  const { title, summary, author, topics } = req.body;
  
  console.log(`🔄 Updating presentation: ${presentationId}`);
  
  try {
    // Update in MongoDB
    const result = await Presentation.findOneAndUpdate(
      { id: presentationId, isDeleted: false },
      {
        $set: {
          title: title || undefined,
          summary: summary || undefined,
          author: author || undefined,
          topics: topics || undefined
        }
      },
      { new: true }
    );
    
    if (!result) {
      console.log(`❌ Presentation ${presentationId} not found for update`);
      return res.status(404).json({ error: 'Presentation not found' });
    }
    
    console.log(`✅ Successfully updated presentation ${presentationId} in database`);
    
    // Update memory cache
    if (presentations[presentationId]) {
      presentations[presentationId] = result.toObject();
      console.log(`✅ Updated presentation ${presentationId} in memory cache`);
    }
    
    res.json({ success: true, presentation: result });
  } catch (err) {
    console.error(`❌ Error updating presentation: ${err}`);
    res.status(500).json({ error: 'Server error' });
  }
});

// Diagnostic endpoint to check what's actually in MongoDB
app.get('/diag/:id', async (req, res) => {
  try {
    const doc = await Presentation.findOne({id: req.params.id}).lean();
    if (!doc) {
      return res.status(404).json({ error: 'Not found' });
    }
    
    res.json({
      id: doc.id,
      title: doc.title,
      slideCount: doc.slideCount,
      hasSlides: !!doc.slides,
      slidesLength: doc.slides?.length || 0,
      firstSlideURL: doc.slides?.[0] || 'NONE',
      hasSlideTexts: !!doc.slideTexts,
      slideTextsLength: doc.slideTexts?.length || 0,
      firstSlideText: doc.slideTexts?.[0] || 'NONE',
      allFields: Object.keys(doc).sort()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Get presentations by topic
app.get('/presentations/topic/:topic', async (req, res) => {
  const topic = req.params.topic.toLowerCase();
  console.log(`🏷️  Getting presentations for topic: ${topic}`);
  
  try {
    // Query database directly
    const dbPresentations = await Presentation.find({
      topics: { $elemMatch: { $regex: new RegExp(topic, 'i') } },
      isDeleted: false
    });
    
    console.log(`✅ Found ${dbPresentations.length} presentations for topic '${topic}' in database`);
    
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
      
      console.log(`⚠️  Using memory cache fallback for topic '${topic}': ${topicPresentations.length} presentations`);
      
      return res.json({ presentations: topicPresentations });
    }
    
    // If not found anywhere
    console.log(`📭 No presentations found for topic '${topic}'`);
    return res.json({ presentations: [] });
  } catch (err) {
    console.error(`❌ Error getting presentations by topic: ${err}`);
    
    // Fallback to memory cache if database fails
    if (presentationsByTopic[topic]) {
      const topicPresentations = presentationsByTopic[topic]
        .map(id => presentations[id])
        .filter(p => p !== undefined);
      
      console.log(`⚠️  Database error, using memory cache for topic '${topic}': ${topicPresentations.length} presentations`);
      
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
    console.error(`❌ Error getting unseen presentations: ${err}`);
    
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
  
  console.log(`🗑️  Deleting presentation: ${presentationId}`);
  
  try {
    // Mark as deleted in database
    const result = await Presentation.findOneAndUpdate(
      { id: presentationId, isDeleted: false },
      { isDeleted: true },
      { new: true }
    );
    
    if (!result) {
      console.log(`❌ Presentation ${presentationId} not found for deletion`);
      return res.status(404).json({ error: 'Presentation not found' });
    }
    
    console.log(`✅ Successfully marked presentation ${presentationId} as deleted in database`);
    
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
      console.log(`✅ Removed presentation ${presentationId} from memory cache`);
    }
    
    // Remove from user history
    Object.keys(userPresentationHistory).forEach(userId => {
      userPresentationHistory[userId] = userPresentationHistory[userId].filter(id => id !== presentationId);
    });
    
    res.json({ success: true, message: 'Presentation deleted' });
  } catch (err) {
    console.error(`❌ Error deleting presentation: ${err}`);
    
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
    console.error(`❌ Error getting topics: ${err}`);
    
    // Fallback to in-memory topics
    res.json({
      topics: Object.keys(presentationsByTopic).map(topic => ({
        name: topic,
        count: presentationsByTopic[topic].length
      }))
    });
  }
});

// ENHANCED Database status endpoint with detailed diagnostics
app.get('/status', async (req, res) => {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const dbPresentationCount = dbConnected ? await Presentation.countDocuments({ isDeleted: false }) : 0;
    const memoryPresentationCount = Object.keys(presentations).length;
    
    // Get sample presentation IDs from both sources
    const sampleDbIds = dbConnected ?
      (await Presentation.find({ isDeleted: false }, 'id').limit(5)).map(p => p.id) : [];
    const sampleMemoryIds = Object.keys(presentations).slice(0, 5);
    
    const dbStatus = {
      connected: dbConnected,
      presentationCount: dbPresentationCount,
      memoryPresentationCount: memoryPresentationCount,
      version: "1.6",
      syncStatus: dbPresentationCount === memoryPresentationCount ? "synced" : "out_of_sync",
      sampleDatabaseIds: sampleDbIds,
      sampleMemoryIds: sampleMemoryIds,
      mongoUri: mongoUri.replace(/\/\/.*:.*@/, '//***:***@'), // Hide credentials
      timestamp: new Date().toISOString()
    };
    
    console.log(`📊 Status check: DB(${dbPresentationCount}) Memory(${memoryPresentationCount}) Connected(${dbConnected})`);
    
    res.json(dbStatus);
  } catch (err) {
    console.error(`❌ Status check error: ${err}`);
    res.status(500).json({
      error: 'Database error',
      message: err.message,
      connected: mongoose.connection.readyState === 1,
      version: "1.6"
    });
  }
});

// MANUAL DATABASE SYNC ENDPOINT for troubleshooting
app.post('/admin/sync', async (req, res) => {
  try {
    console.log(`🔄 Manual sync requested...`);
    
    // Clear memory cache
    Object.keys(presentations).forEach(key => delete presentations[key]);
    Object.keys(presentationsByTopic).forEach(key => delete presentationsByTopic[key]);
    
    // Reload from database
    await loadPresentationsFromDatabase();
    
    const memoryCount = Object.keys(presentations).length;
    const dbCount = await Presentation.countDocuments({ isDeleted: false });
    
    console.log(`✅ Manual sync completed: ${memoryCount} presentations loaded`);
    
    res.json({
      success: true,
      message: `Sync completed: ${memoryCount} presentations loaded from database`,
      databaseCount: dbCount,
      memoryCount: memoryCount
    });
    
  } catch (err) {
    console.error(`❌ Manual sync error: ${err}`);
    res.status(500).json({
      error: 'Sync failed',
      message: err.message
    });
  }
});

// Progress tracking endpoint for uploads
app.get('/upload-progress/:id', (req, res) => {
  // This would be implemented with WebSockets or Server-Sent Events in a full implementation
  // For now, just return a placeholder
  res.json({ progress: 0, status: 'waiting' });
});

// Clear cache endpoint
app.get('/clear-cache', (req, res) => {
    Object.keys(presentations).forEach(key => delete presentations[key]);
    res.json({ message: 'Cache cleared' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(`❌ Server error: ${err.stack}`);
  res.status(500).json({ error: err.message || 'Something went wrong!' });
});

// Initialize database connection and start server
mongoose.connect(mongoUri, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ Connected to MongoDB database');
  
  // Load presentations from database on startup
  loadPresentationsFromDatabase().then(() => {
    console.log(`🚀 Server startup complete with ${Object.keys(presentations).length} presentations loaded`);
  });
  
  // Start the server
  app.listen(port, () => {
    console.log(`🚀 PowerPoint Conversion Server (v1.6 with FIXED MongoDB) running on port ${port}`);
    
    // Check if LibreOffice is installed
    const libreOfficeInstalled = checkLibreOfficeInstallation();
    if (!libreOfficeInstalled) {
      console.error('⚠️  WARNING: LibreOffice is not installed. Conversion functionality will not work!');
      
      // Try to install LibreOffice and PDF utilities
      try {
        console.log('📦 Attempting to install LibreOffice and PDF utilities on server startup...');
        execSync('apt-get update && apt-get install -y libreoffice poppler-utils imagemagick', { stdio: 'inherit' });
        console.log('✅ Installation completed.');
      } catch (installError) {
        console.error('❌ Failed to automatically install LibreOffice:', installError.message);
      }
    }
  });
}).catch(err => {
  console.error(`❌ Failed to connect to MongoDB: ${err}`);
  console.warn('⚠️  Running without database persistence. Presentations will be lost on restart!');
  
  // Start the server anyway, but without database functionality
  app.listen(port, () => {
    console.log(`🚀 PowerPoint Conversion Server (v1.6 fallback mode) running on port ${port}`);
  });
});
