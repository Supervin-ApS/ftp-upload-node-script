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

# Folder 1 - Many small files (simulating production load)
mkdir -p websiteImages/folder1
echo "Generating 500 small files in websiteImages/folder1..."
for i in {1..500}; do
    echo "This is small file number $i - $(date)" > "websiteImages/folder1/small_file_$i.txt"
done

# Folder 2 - Mixed sizes
mkdir -p websiteImages/folder2
echo "Generating mixed sized files in websiteImages/folder2..."

# Create a 6MB file (just over 5MB threshold)
echo "Creating 6MB file..."
dd if=/dev/urandom of=websiteImages/folder2/large_file_6mb.bin bs=1M count=6 2>/dev/null

# Create a 12MB file
echo "Creating 12MB file..."
dd if=/dev/urandom of=websiteImages/folder2/large_file_12mb.bin bs=1M count=12 2>/dev/null

# Create some medium files (1MB)
echo "Creating 5 medium files (1MB)..."
for i in {1..5}; do
    dd if=/dev/urandom of="websiteImages/folder2/medium_file_${i}_1mb.bin" bs=1M count=1 2>/dev/null
done

# Create 360Images test structure
echo "Creating 360Images test structure..."

# Folder 3 - 360 images simulation
mkdir -p 360Images/folder3
echo "Generating 100 files in 360Images/folder3..."
for i in {1..100}; do
    echo "This is 360 panorama file number $i" > "360Images/folder3/pano_$i.txt"
done

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
