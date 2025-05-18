# PowerPoint Conversion Server

A dedicated server for converting PowerPoint presentations to images for the dWorld app.

## Features

- Upload PowerPoint (.ppt, .pptx) files and Keynote (.key) files
- Convert presentations to JPG images using LibreOffice
- Retrieve individual slides or entire presentations
- Manage uploaded presentations

## Prerequisites

- Node.js 14+
- LibreOffice installed on the server

## Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Make sure LibreOffice is installed and accessible from the command line

## Running the Server

For development:
```
npm run dev
```

For production:
```
npm start
```

## API Endpoints

### Upload and Convert a Presentation
```
POST /convert
```
- Submit a multipart form with a 'presentation' field containing the PowerPoint file
- Returns presentation metadata including ID, slide count, and URLs

### Get Presentation Info
```
GET /presentation/:id
```
- Returns metadata for the specified presentation

### Get a Specific Slide
```
GET /slides/:presentationId/:slideNumber
```
- Redirects to the specific slide image

### List All Presentations
```
GET /presentations
```
- Returns a list of all converted presentations

### Delete a Presentation
```
DELETE /presentation/:id
```
- Deletes a presentation and all its slides

## Docker Deployment

Build the Docker image:
```
docker build -t ppt-conversion-server .
```

Run the container:
```
docker run -p 3001:3001 ppt-conversion-server
```

## Railway Deployment

This server can be easily deployed to Railway. Simply connect your repository and Railway will use the included Dockerfile for deployment.

## Directory Structure

- `/uploads` - Temporary storage for uploaded files
- `/public/slides/:presentationId` - Converted slides for each presentation
