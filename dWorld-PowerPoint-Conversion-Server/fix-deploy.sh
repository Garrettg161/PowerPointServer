#!/bin/bash
# Script to fix the PowerPoint Conversion Server deployment issues

# Change to the PowerPoint server directory
cd /Users/garrettgruener/Desktop/game-server/PowerPointServer

# Step 1: Rename the main JavaScript file
echo "Step 1: Renaming ppt-converter-server.js to server.js"
if [ -f "ppt-converter-server.js" ]; then
    mv ppt-converter-server.js server.js
    echo "✅ File renamed successfully"
else
    echo "⚠️ File ppt-converter-server.js not found, checking for alternatives..."
    
    # Check if we're dealing with a differently named main JS file
    MAIN_JS_FILE=$(find . -maxdepth 1 -name "*.js" | grep -v "node_modules" | head -1)
    if [ -n "$MAIN_JS_FILE" ]; then
        echo "Found main JS file: $MAIN_JS_FILE"
        cp "$MAIN_JS_FILE" server.js
        echo "✅ Copied $MAIN_JS_FILE to server.js"
    else
        echo "❌ No JavaScript files found in the directory. Please check the repository."
        exit 1
    fi
fi

# Step 2: Update package.json
echo "Step 2: Updating package.json"
if [ -f "package.json" ]; then
    # Create a backup
    cp package.json package.json.bak
    
    # Update the start script to use server.js
    cat package.json | sed 's/"start": "node .*"/"start": "node server.js"/' > package.json.new
    mv package.json.new package.json
    echo "✅ package.json updated"
else
    echo "❌ package.json not found. Creating a basic one..."
    
    # Create a minimal package.json
    cat > package.json << EOF
{
  "name": "ppt-conversion-server",
  "version": "1.0.0",
  "description": "Server for converting PowerPoint files to images",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "multer": "^1.4.5-lts.1",
    "uuid": "^9.0.0"
  },
  "engines": {
    "node": ">=14.0.0"
  }
}
EOF
    echo "✅ Created new package.json file"
fi

# Step 3: Commit and push changes
echo "Step 3: Committing and pushing changes"
git add server.js package.json
git commit -m "Fixed deployment issues: renamed main file and updated package.json"
git push
echo "✅ Changes committed and pushed to GitHub"

# Step 4: Redeploy to Railway
echo "Step 4: Redeploying to Railway"
railway up
echo "✅ Deployment initiated"

echo ""
echo "All steps completed. The server should now deploy successfully."
echo "To check logs after deployment, run: railway logs"
echo "To get your service URL, run: railway domain"

# Exit with success
exit 0
