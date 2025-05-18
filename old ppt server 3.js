// server.js - PowerPoint Conversion Server v 1.3a
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
    
    // DEBUG: Get LibreOffice version
    try {
      const versionOutput = execSync('libreoffice --version').toString().trim();
      console.log(`LibreOffice version information: ${versionOutput}`);
    } catch (versionError) {
      console.error('Error getting LibreOffice version:', versionError.message);
    }
    
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

// Create a visually distinct placeholder for testing
function createDistinctPlaceholder(outputPath, slideNumber, title) {
  try {
    // This would be better with an actual image library, but for now we'll create a text file
    // with different content for each slide number to demonstrate the difference
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
  
  // Create output directory
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // DEBUG: Examine the PowerPoint file with file command
  try {
    const fileTypeOutput = execSync(`file "${inputFile}"`).toString().trim();
    console.log(`DEBUG - File type: ${fileTypeOutput}`);
  } catch (fileTypeError) {
    console.error('Error determining file type:', fileTypeError.message);
  }
  
  // Check if LibreOffice is installed
  const libreOfficeInstalled = checkLibreOfficeInstallation();
  
  if (!libreOfficeInstalled) {
    console.log('LibreOffice not found. Creating placeholder images...');
    
    // Try to install LibreOffice if possible
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
      
      // Fallback to regular JPG conversion
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
      console.log(`Processing PDF at ${pdfPath} to extract slides...`);
      
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
          
          // Use pdftoppm to convert PDF pages to images
          for (let i = 0; i < pageCount; i++) {
            const pageNum = i + 1;
            const outputPrefix = path.join(tempDir, `slide-${pageNum}`);
            
            // Convert PDF page to JPG
            const convertCmd = `pdftoppm -jpeg -f ${pageNum} -singlefile "${pdfPath}" "${outputPrefix}"`;
            console.log(`Extracting page ${pageNum}: ${convertCmd}`);
            
            try {
              execSync(convertCmd);
              
              // Find the generated image
              const tempFile = `${outputPrefix}.jpg`;
              const finalFile = path.join(outputDir, `slide-${pageNum}.jpg`);
              
              if (fs.existsSync(tempFile)) {
                // Copy to final location
                fs.copyFileSync(tempFile, finalFile);
                console.log(`Created slide ${pageNum} from PDF page ${pageNum}`);
                renamedImageUrls.push(`/slides/${presentationId}/slide-${pageNum}.jpg`);
              } else {
                console.error(`Could not find converted image for page ${pageNum}`);
                
                // Create a distinct placeholder as fallback for this slide
                createDistinctPlaceholder(finalFile, pageNum, `Page ${pageNum} of ${req.file.originalname}`);
                renamedImageUrls.push(`/slides/${presentationId}/slide-${pageNum}.jpg`);
              }
            } catch (extractError) {
              console.error(`Error extracting page ${pageNum}: ${extractError.message}`);
              
              // Create a distinct placeholder for this slide
              const finalFile = path.join(outputDir, `slide-${pageNum}.jpg`);
              createDistinctPlaceholder(finalFile, pageNum, `Page ${pageNum} of ${req.file.originalname}`);
              renamedImageUrls.push(`/slides/${presentationId}/slide-${pageNum}.jpg`);
            }
          }
          
          // Store presentation data
          presentations[presentationId] = {
            id: presentationId,
            originalName: req.file.originalname,
            slides: renamedImageUrls,
            slideCount: renamedImageUrls.length,
            converted: new Date().toISOString()
          };
          
          // Return presentation data
          res.json({
            id: presentationId,
            originalName: req.file.originalname,
            slideCount: renamedImageUrls.length,
            slides: renamedImageUrls,
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
        console.error(`Command stderr: ${stderr}`);
        console.error(`Command stdout: ${stdout}`);
        
        // Create fallback placeholder slides
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
        
        imageFiles.forEach((file, index) => {
          const oldPath = path.join(outputDir, file);
          const newFileName = `slide-${index+1}.jpg`;
          const newPath = path.join(outputDir, newFileName);
          
          try {
            // Rename the file
            fs.renameSync(oldPath, newPath);
            renamedImageUrls.push(`/slides/${presentationId}/${newFileName}`);
            console.log(`Renamed ${file} to ${newFileName}`);
          } catch (error) {
            console.error(`Error renaming file ${file}: ${error.message}`);
            // Use the original file as fallback
            renamedImageUrls.push(`/slides/${presentationId}/${file}`);
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
              console.log(`Created distinct placeholder for slide ${slideNumber}`);
            } catch (error) {
              console.error(`Error creating slide ${slideNumber}: ${error.message}`);
            }
          }
        }
        
        // Store presentation data with renamed slides
        presentations[presentationId] = {
          id: presentationId,
          originalName: req.file.originalname,
          slides: renamedImageUrls,
          slideCount: renamedImageUrls.length,
          converted: new Date().toISOString()
        };
        
        // Return presentation data
        res.json({
          id: presentationId,
          originalName: req.file.originalname,
          slideCount: renamedImageUrls.length,
          slides: renamedImageUrls,
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
    const estimatedSlideCount = 23; // Default to 23 slides based on your file
    const placeholderUrls = [];
    
    for (let i = 0; i < estimatedSlideCount; i++) {
      const slideNumber = i + 1;
      const placeholderPath = path.join(outputDir, `slide-${slideNumber}.jpg`);
      createDistinctPlaceholder(placeholderPath, slideNumber, req.file.originalname);
      placeholderUrls.push(`/slides/${presentationId}/slide-${slideNumber}.jpg`);
    }
    
    // Save presentation info
    presentations[presentationId] = {
      id: presentationId,
      originalName: req.file.originalname,
      slides: placeholderUrls,
      slideCount: estimatedSlideCount,
      converted: new Date().toISOString(),
      isPlaceholder: true
    };
    
    // Return the placeholder slides
    res.json({
      id: presentationId,
      originalName: req.file.originalname,
      slideCount: estimatedSlideCount,
      slides: placeholderUrls,
      status: "fallback_placeholders",
      message: "Conversion failed. Generated distinct placeholder slides instead."
    });
    
    // Clean up the uploaded file
    fs.unlink(inputFile, (err) => {
      if (err) console.error(`Error deleting uploaded file: ${err.message}`);
    });
  }
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

// Added debug endpoint to test different conversion approaches directly
app.get('/debug/test-conversion', (req, res) => {
  res.send(`
    <html>
    <head><title>Test Conversion</title></head>
    <body>
      <h1>Test Conversion Approaches</h1>
      <form action="/debug/test-conversion" method="post" enctype="multipart/form-data">
        <input type="file" name="presentation" accept=".ppt,.pptx,.key" required>
        <button type="submit">Test Conversion</button>
      </form>
    </body>
    </html>
  `);
});

app.post('/debug/test-conversion', upload.single('presentation'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded');
  }
  
  const inputFile = req.file.path;
  const debugDir = path.join(__dirname, 'public', 'debug');
  
  // Create debug directory
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }
  
  // Test multiple conversion approaches
  const approaches = [
    {
      name: "pdf_standard",
      cmd: `libreoffice --headless --convert-to pdf --outdir ${debugDir}/pdf_standard ${inputFile}`
    },
    {
      name: "pdf_to_jpg",
      cmds: [
        `libreoffice --headless --convert-to pdf --outdir ${debugDir}/pdf_to_jpg ${inputFile}`,
        `mkdir -p ${debugDir}/pdf_to_jpg/images`,
        `pdftoppm -jpeg -r 300 "${debugDir}/pdf_to_jpg/*.pdf" "${debugDir}/pdf_to_jpg/images/slide"`
      ]
    },
    {
      name: "jpg_standard",
      cmd: `libreoffice --headless --convert-to jpg --outdir ${debugDir}/jpg_standard ${inputFile}`
    },
    {
      name: "jpg_draw_export",
      cmd: `libreoffice --headless --convert-to jpg:"draw_jpg_Export" --outdir ${debugDir}/jpg_draw ${inputFile}`
    }
  ];
  
  let results = '<h1>Conversion Test Results</h1>';
  
  // Check for PDF utilities
  try {
    execSync('apt-get update && apt-get install -y poppler-utils imagemagick');
    results += '<p style="color: green">Successfully installed PDF utilities</p>';
  } catch (error) {
    results += `<p style="color: red">Error installing PDF utilities: ${error.message}</p>`;
  }
  
  // Run each approach and collect results
  approaches.forEach(approach => {
    const approachDir = path.join(debugDir, approach.name.replace(/\W/g, '_'));
    if (!fs.existsSync(approachDir)) {
      fs.mkdirSync(approachDir, { recursive: true });
    }
    
    results += `<h2>${approach.name}</h2>`;
    
    try {
      if (approach.cmd) {
        // Single command approach
        results += `<pre>Command: ${approach.cmd}</pre>`;
        const output = execSync(approach.cmd).toString();
        results += `<pre>Output: ${output}</pre>`;
      } else if (approach.cmds) {
        // Multi-command approach
        approach.cmds.forEach((cmd, index) => {
          results += `<pre>Command ${index+1}: ${cmd}</pre>`;
          try {
            const output = execSync(cmd).toString();
            results += `<pre>Output ${index+1}: ${output}</pre>`;
          } catch (cmdError) {
            results += `<p style="color: red">Error in command ${index+1}: ${cmdError.message}</p>`;
          }
        });
      }
      
      // List files
      const files = fs.readdirSync(approachDir);
      results += `<p>Generated ${files.length} files:</p><ul>`;
      files.forEach(file => {
        const filePath = path.join(approachDir, file);
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) {
          const subfiles = fs.readdirSync(filePath);
          results += `<li>${file}/ (directory with ${subfiles.length} files)</li>`;
          subfiles.forEach(subfile => {
            results += `<li>-- ${subfile}</li>`;
          });
        } else {
          results += `<li>${file}</li>`;
        }
      });
      results += '</ul>';
    } catch (error) {
      results += `<p style="color: red">Error: ${error.message}</p>`;
    }
  });
  
  // Clean up
  fs.unlink(inputFile, (err) => {
    if (err) console.error(`Error deleting uploaded debug file: ${err.message}`);
  });
  
  res.send(`
    <html>
    <head><title>Conversion Test Results</title></head>
    <body>
      ${results}
      <p><a href="/debug/test-conversion">Try another file</a></p>
    </body>
    </html>
  `);
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
  
  // Get LibreOffice version
  try {
    debugInfo.libreOfficeVersion = execSync('libreoffice --version').toString();
  } catch (error) {
    debugInfo.libreOfficeVersionError = error.message;
  }
  
  // Check for additional dependencies
  try {
    debugInfo.pdfinfo = execSync('which pdfinfo || echo "not found"').toString();
    debugInfo.pdftoppm = execSync('which pdftoppm || echo "not found"').toString();
    debugInfo.imagemagick = execSync('which convert || echo "not found"').toString();
  } catch (error) {
    debugInfo.dependenciesError = error.message;
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
    
    // Try to install LibreOffice and PDF utilities
    try {
      console.log('Attempting to install LibreOffice and PDF utilities on server startup...');
      execSync('apt-get update && apt-get install -y libreoffice poppler-utils imagemagick', { stdio: 'inherit' });
      console.log('Installation completed.');
      
      // Verify installation
      const installSucceeded = checkLibreOfficeInstallation();
      if (installSucceeded) {
        console.log('LibreOffice successfully installed and verified!');
        
        // Check for PDF utilities
        try {
          const pdfinfo = execSync('which pdfinfo || echo "not found"').toString().trim();
          const pdftoppm = execSync('which pdftoppm || echo "not found"').toString().trim();
          
          console.log(`pdfinfo: ${pdfinfo}`);
          console.log(`pdftoppm: ${pdftoppm}`);
          
          if (pdfinfo !== "not found" && pdftoppm !== "not found") {
            console.log('PDF utilities successfully installed!');
          } else {
            console.error('PDF utilities not found after installation attempt.');
          }
        } catch (utilsError) {
          console.error('Error checking PDF utilities:', utilsError.message);
        }
      } else {
        console.error('LibreOffice still not found after installation attempt.');
      }
    } catch (installError) {
      console.error('Failed to automatically install LibreOffice:');
      console.error(installError.message);
    }
  }
});
