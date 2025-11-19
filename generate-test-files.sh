#!/bin/bash
# Script to generate test folders and files for testing the upload script

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}Generating test folders and files...${NC}"

# Clean up existing test folders
echo "Cleaning up existing test folders..."
rm -rf websiteImages/folder* 360Images/folder*

# Create websiteImages test structure
echo "Creating websiteImages test structure..."

# Folder 1 - with subfolder
mkdir -p websiteImages/folder1/subfolder
cat > websiteImages/folder1/image1.txt << 'EOF'
This is a test file simulating an image upload.
Folder: folder1
File: image1.txt
Timestamp: $(date -Iseconds)
EOF

cat > websiteImages/folder1/image2.txt << 'EOF'
This is a test file simulating an image upload.
Folder: folder1
File: image2.txt
Timestamp: $(date -Iseconds)
EOF

cat > websiteImages/folder1/subfolder/image3.txt << 'EOF'
This is a test file in a subfolder.
Folder: folder1/subfolder
File: image3.txt
Timestamp: $(date -Iseconds)
EOF

# Folder 2
mkdir -p websiteImages/folder2
cat > websiteImages/folder2/product1.txt << 'EOF'
This is a test file simulating an image upload.
Folder: folder2
File: product1.txt
Timestamp: $(date -Iseconds)
EOF

cat > websiteImages/folder2/product2.txt << 'EOF'
This is a test file simulating an image upload.
Folder: folder2
File: product2.txt
Timestamp: $(date -Iseconds)
EOF

cat > websiteImages/folder2/product3.txt << 'EOF'
This is a test file simulating an image upload.
Folder: folder2
File: product3.txt
Timestamp: $(date -Iseconds)
EOF

# Create 360Images test structure
echo "Creating 360Images test structure..."

# Folder 3
mkdir -p 360Images/folder3
cat > 360Images/folder3/panorama1.txt << 'EOF'
This is a test file simulating a 360-degree image upload.
Folder: folder3
File: panorama1.txt
Timestamp: $(date -Iseconds)
Type: 360-degree panorama
EOF

cat > 360Images/folder3/panorama2.txt << 'EOF'
This is a test file simulating a 360-degree image upload.
Folder: folder3
File: panorama2.txt
Timestamp: $(date -Iseconds)
Type: 360-degree panorama
EOF

cat > 360Images/folder3/panorama3.txt << 'EOF'
This is a test file simulating a 360-degree image upload.
Folder: folder3
File: panorama3.txt
Timestamp: $(date -Iseconds)
Type: 360-degree panorama
EOF

# Folder 4 - with nested structure
mkdir -p 360Images/folder4/room1 360Images/folder4/room2
cat > 360Images/folder4/room1/view1.txt << 'EOF'
This is a test file simulating a 360-degree image upload.
Folder: folder4/room1
File: view1.txt
Timestamp: $(date -Iseconds)
Type: 360-degree panorama - Room 1
EOF

cat > 360Images/folder4/room2/view2.txt << 'EOF'
This is a test file simulating a 360-degree image upload.
Folder: folder4/room2
File: view2.txt
Timestamp: $(date -Iseconds)
Type: 360-degree panorama - Room 2
EOF

echo -e "${GREEN}✓ Test files generated successfully!${NC}"
echo ""
echo "Structure created:"
echo ""

# Display the structure
if command -v tree &> /dev/null; then
    tree -L 3 websiteImages 360Images
else
    echo "websiteImages/"
    find websiteImages -type f | sort | sed 's|^|  |'
    echo ""
    echo "360Images/"
    find 360Images -type f | sort | sed 's|^|  |'
fi

echo ""
echo -e "${BLUE}Total files created:${NC}"
echo "  websiteImages: $(find websiteImages -type f | wc -l) files"
echo "  360Images: $(find 360Images -type f | wc -l) files"
echo "  Total: $(find websiteImages 360Images -type f 2>/dev/null | wc -l) files"
