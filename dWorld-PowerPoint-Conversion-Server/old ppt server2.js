// server.js - PowerPoint Conversion Server
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { exec, execSync } = require('child_process');
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
    console.error('Error checking for LibreOffice:');
    console.error(error.message);
    return false;
  }
}

// Function to create a placeholder image for when LibreOffice isn't available
function createPlaceholderImage(outputPath, slideNumber, title) {
  // Create a very simple text file as a placeholder
  // In a production environment, you might want to use a package like 'sharp'
  // to generate actual placeholder images
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
  
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // Check if LibreOffice is installed
  const libreOfficeInstalled = checkLibreOfficeInstallation();
  
  if (!libreOfficeInstalled) {
    console.log('LibreOffice not found. Creating placeholder images...');
    
    // Try to install LibreOffice if possible
    try {
      console.log('Attempting to install LibreOffice...');
      execSync('apt-get update && apt-get install -y libreoffice', { stdio: 'inherit' });
      console.log('LibreOffice installation completed. Retrying conversion...');
      
      // Check if installation succeeded
      const installSucceeded = checkLibreOfficeInstallation();
      if (!installSucceeded) {
        throw new Error('LibreOffice still not available after installation attempt');
      }
    } catch (installError) {
      console.error('Failed to install LibreOffice:');
      console.error(installError.message);
      
      // Create placeholder slides as fallback
      const placeholderCount = 5; // Create a few placeholder slides
      const placeholderUrls = [];
      
      for (let i = 0; i < placeholderCount; i++) {
        const placeholderPath = path.join(outputDir, `slide-${i+1}.jpg`);
        createPlaceholderImage(placeholderPath, i+1, req.file.originalname);
        placeholderUrls.push(`/slides/${presentationId}/slide-${i+1}.jpg`);
      }
      
      // Save presentation info
      presentations[presentationId] = {
        id: presentationId,
        originalName: req.file.originalname,
        slides: placeholderUrls,
        slideCount: placeholderCount,
        converted: new Date().toISOString(),
        isPlaceholder: true
      };
      
      // Return the placeholder slides
      return res.json({
        id: presentationId,
        originalName: req.file.originalname,
        slideCount: placeholderCount,
        slides: placeholderUrls,
        status: "placeholders_created",
        message: "LibreOffice is not available. Generated placeholder slides instead."
      });
    }
  }
  
  console.log(`Converting PowerPoint to JPG images in ${outputDir}`);
  
  // Use LibreOffice to convert PowerPoint to JPG
  const cmd = `libreoffice --headless --convert-to jpg --outdir ${outputDir} ${inputFile}`;
  console.log(`Executing command: ${cmd}`);
  
  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error(`Conversion error: ${error.message}`);
      console.error(`Command stderr: ${stderr}`);
      console.error(`Command stdout: ${stdout}`);
      
      // Try to get more information about the error
      try {
        console.log('Checking LibreOffice version...');
        const versionInfo = execSync('libreoffice --version').toString().trim();
        console.log(`LibreOffice version: ${versionInfo}`);
      } catch (versionError) {
        console.error('Error getting LibreOffice version:', versionError.message);
      }
      
      // Create fallback placeholder slides
      const placeholderCount = 5;
      const placeholderUrls = [];
      
      for (let i = 0; i < placeholderCount; i++) {
        const placeholderPath = path.join(outputDir, `slide-${i+1}.jpg`);
        createPlaceholderImage(placeholderPath, i+1, req.file.originalname);
        placeholderUrls.push(`/slides/${presentationId}/slide-${i+1}.jpg`);
      }
      
      // Save presentation info with error details
      presentations[presentationId] = {
        id: presentationId,
        originalName: req.file.originalname,
        slides: placeholderUrls,
        slideCount: placeholderCount,
        converted: new Date().toISOString(),
        error: error.message,
        isPlaceholder: true
      };
      
      // Return the placeholder slides along with error info
      return res.json({
        id: presentationId,
        originalName: req.file.originalname,
        slideCount: placeholderCount,
        slides: placeholderUrls,
        status: "conversion_failed",
        message: "Conversion failed. Generated placeholder slides instead.",
        error: {
          message: error.message,
          stdout: stdout,
          stderr: stderr
        }
      });
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
      
      // If no images were generated, create placeholders
      if (imageFiles.length === 0) {
        console.log('No images were generated. Creating placeholders...');
        
        const placeholderCount = 5;
        const placeholderUrls = [];
        
        for (let i = 0; i < placeholderCount; i++) {
          const placeholderPath = path.join(outputDir, `slide-${i+1}.jpg`);
          createPlaceholderImage(placeholderPath, i+1, req.file.originalname);
          placeholderUrls.push(`/slides/${presentationId}/slide-${i+1}.jpg`);
        }
        
        // Save presentation info
        presentations[presentationId] = {
          id: presentationId,
          originalName: req.file.originalname,
          slides: placeholderUrls,
          slideCount: placeholderCount,
          converted: new Date().toISOString(),
          isPlaceholder: true
        };
        
        // Return the placeholder slides
        return res.json({
          id: presentationId,
          originalName: req.file.originalname,
          slideCount: placeholderCount,
          slides: placeholderUrls,
          status: "no_images_generated",
          message: "No images were generated. Created placeholder slides instead."
        });
      }
      
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
        slides: imageUrls,
        status: "success"
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
    converted: p.converted,
    isPlaceholder: p.isPlaceholder || false
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

// Environment info endpoint for debugging
app.get('/debug/environment', (req, res) => {
  const debugInfo = {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    env: Object.keys(process.env).filter(key => !key.includes('TOKEN') && !key.includes('KEY')),
    libreOfficeInstalled: checkLibreOfficeInstallation(),
    serverUptime: process.uptime()
  };
  
  // Try to get more system info
  try {
    debugInfo.diskSpace = execSync('df -h').toString();
  } catch (error) {
    debugInfo.diskSpaceError = error.message;
  }
  
  try {
    debugInfo.memoryInfo = execSync('free -m').toString();
  } catch (error) {
    debugInfo.memoryInfoError = error.message;
  }
  
  res.json(debugInfo);
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Something went wrong!' });
});

// Start the server
app.listen(port, () => {
  console.log(`PowerPoint Conversion Server running on port ${port}`);
  
  // Check if LibreOffice is installed
  const libreOfficeInstalled = checkLibreOfficeInstallation();
  if (!libreOfficeInstalled) {
    console.error('WARNING: LibreOffice is not installed. Conversion functionality will not work!');
    console.error('Please make sure LibreOffice is installed and in the PATH');
    
    // Try to install LibreOffice
    try {
      console.log('Attempting to install LibreOffice on server startup...');
      execSync('apt-get update && apt-get install -y libreoffice', { stdio: 'inherit' });
      console.log('LibreOffice installation completed.');
      
      // Verify installation
      const installSucceeded = checkLibreOfficeInstallation();
      if (installSucceeded) {
        console.log('LibreOffice successfully installed and verified!');
      } else {
        console.error('LibreOffice still not found after installation attempt.');
      }
    } catch (installError) {
      console.error('Failed to automatically install LibreOffice:');
      console.error(installError.message);
    }
  }
});
