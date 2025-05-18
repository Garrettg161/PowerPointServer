// server.js - PowerPoint Conversion Server
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = process.env.PORT || 3001;

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
  // Accept only PowerPoint file extensions (.ppt, .pptx, .key)
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

// In-memory storage for presentations
const presentations = {};

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
  
  console.log(`Received file: ${req.file.originalname}`);
  
  const inputFile = req.file.path;
  const presentationId = uuidv4();
  const outputDir = path.join(__dirname, 'public', 'slides', presentationId);
  
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  console.log(`Converting PowerPoint to JPG images in ${outputDir}`);
  
  // Use LibreOffice to convert PowerPoint to JPG
  exec(`libreoffice --headless --convert-to jpg --outdir ${outputDir} ${inputFile}`, 
    (error, stdout, stderr) => {
      if (error) {
        console.error(`Conversion error: ${error.message}`);
        return res.status(500).json({ error: 'Conversion failed', details: error.message });
      }
      
      console.log(`Conversion output: ${stdout}`);
      
      // Get the generated images
      fs.readdir(outputDir, (err, files) => {
        if (err) {
          console.error(`Error reading output directory: ${err.message}`);
          return res.status(500).json({ error: 'Failed to read converted files' });
        }
        
        // Filter for JPG files and sort them
        const imageFiles = files
          .filter(file => file.endsWith('.jpg'))
          .sort((a, b) => {
            // Sort by numeric part of the filename if possible
            const numA = parseInt(a.match(/\d+/)?.[0] || '0');
            const numB = parseInt(b.match(/\d+/)?.[0] || '0');
            return numA - numB;
          });
        
        const imageUrls = imageFiles.map(file => 
          `/slides/${presentationId}/${file}`
        );
        
        // Store presentation data
        presentations[presentationId] = {
          id: presentationId,
          originalName: req.file.originalname,
          slides: imageUrls,
          slideCount: imageUrls.length,
          converted: new Date().toISOString()
        };
        
        // Return presentation data
        res.json({ 
          id: presentationId,
          originalName: req.file.originalname,
          slideCount: imageUrls.length,
          slides: imageUrls 
        });
        
        // Clean up the uploaded file
        fs.unlink(inputFile, (err) => {
          if (err) console.error(`Error deleting uploaded file: ${err.message}`);
        });
      });
    });
});

// Get presentation info endpoint
app.get('/presentation/:id', (req, res) => {
  const presentationId = req.params.id;
  
  if (!presentations[presentationId]) {
    return res.status(404).json({ error: 'Presentation not found' });
  }
  
  res.json(presentations[presentationId]);
});

// Get specific slide endpoint
app.get('/slides/:presentationId/:slideNumber', (req, res) => {
  const { presentationId, slideNumber } = req.params;
  const slideIndex = parseInt(slideNumber) - 1; // Convert to zero-based index
  
  if (!presentations[presentationId]) {
    return res.status(404).json({ error: 'Presentation not found' });
  }
  
  if (isNaN(slideIndex) || slideIndex < 0 || slideIndex >= presentations[presentationId].slideCount) {
    return res.status(404).json({ error: 'Slide not found' });
  }
  
  const slidePath = presentations[presentationId].slides[slideIndex];
  res.redirect(slidePath); // Redirect to the actual image file
});

// Get list of presentations
app.get('/presentations', (req, res) => {
  const presentationList = Object.values(presentations).map(p => ({
    id: p.id,
    originalName: p.originalName,
    slideCount: p.slideCount,
    converted: p.converted
  }));
  
  res.json({ presentations: presentationList });
});

// Delete presentation endpoint
app.delete('/presentation/:id', (req, res) => {
  const presentationId = req.params.id;
  
  if (!presentations[presentationId]) {
    return res.status(404).json({ error: 'Presentation not found' });
  }
  
  const outputDir = path.join(__dirname, 'public', 'slides', presentationId);
  
  // Remove the presentation directory
  fs.rm(outputDir, { recursive: true, force: true }, (err) => {
    if (err) {
      console.error(`Error deleting presentation files: ${err.message}`);
      return res.status(500).json({ error: 'Failed to delete presentation files' });
    }
    
    // Remove from memory
    delete presentations[presentationId];
    res.json({ success: true, message: 'Presentation deleted' });
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Something went wrong!' });
});

// Start the server
app.listen(port, () => {
  console.log(`PowerPoint Conversion Server running on port ${port}`);
});
