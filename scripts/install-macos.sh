#!/bin/bash
#
# ProjectMind Agent - macOS Installer
# One-command installation script for macOS
#
# Usage: curl -fsSL https://projectm.dev/install.sh | bash
#

set -e

AGENT_VERSION="latest"
DOWNLOAD_BASE_URL="https://projectm.dev/downloads/agent"
INSTALL_DIR="$HOME/.projectmind"
BINARY_NAME="projectmind-agent"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_header() {
  echo ""
  echo "╔═══════════════════════════════════════════════════════════╗"
  echo "║       ProjectMind Agent - macOS Installer                ║"
  echo "╚═══════════════════════════════════════════════════════════╝"
  echo ""
}

print_success() {
  echo -e "${GREEN}✓${NC} $1"
}

print_error() {
  echo -e "${RED}✗${NC} $1"
}

print_info() {
  echo -e "${BLUE}→${NC} $1"
}

print_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

detect_arch() {
  local arch=$(uname -m)
  if [ "$arch" = "arm64" ]; then
    echo "macos-arm64"
  elif [ "$arch" = "x86_64" ]; then
    echo "macos-x64"
  else
    print_error "Unsupported architecture: $arch"
    exit 1
  fi
}

download_agent() {
  local arch=$1
  local zip_name="projectmind-agent-${arch}.zip"
  local download_url="${DOWNLOAD_BASE_URL}/${zip_name}"
  local temp_zip="/tmp/${zip_name}"
  
  print_info "Downloading ProjectMind Agent for $arch..."
  
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$download_url" -o "$temp_zip"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$download_url" -O "$temp_zip"
  else
    print_error "Neither curl nor wget found. Please install one of them."
    exit 1
  fi
  
  print_success "Downloaded agent"
  echo "$temp_zip"
}

install_agent() {
  local zip_file=$1
  local temp_dir="/tmp/projectmind-agent-install"
  
  print_info "Installing to $INSTALL_DIR..."
  
  # Clean up any existing temp directory
  rm -rf "$temp_dir"
  mkdir -p "$temp_dir"
  
  # Unzip
  if ! command -v unzip >/dev/null 2>&1; then
    print_error "unzip not found. Please install it: brew install unzip"
    exit 1
  fi
  
  unzip -q "$zip_file" -d "$temp_dir"
  
  # Create install directory
  mkdir -p "$INSTALL_DIR"
  
  # Copy files
  cp "$temp_dir/$BINARY_NAME" "$INSTALL_DIR/"
  if [ -f "$temp_dir/.env" ]; then
    cp "$temp_dir/.env" "$INSTALL_DIR/.env.example"
  fi
  if [ -f "$temp_dir/README.txt" ]; then
    cp "$temp_dir/README.txt" "$INSTALL_DIR/"
  fi
  
  # Make executable
  chmod +x "$INSTALL_DIR/$BINARY_NAME"
  
  # Clear quarantine
  if command -v xattr >/dev/null 2>&1; then
    xattr -dr com.apple.quarantine "$INSTALL_DIR" 2>/dev/null || true
    print_success "Cleared macOS quarantine"
  fi
  
  # Clean up
  rm -rf "$temp_dir"
  rm -f "$zip_file"
  
  print_success "Installed to $INSTALL_DIR"
}

add_to_path() {
  local shell_rc=""
  
  if [ -n "$ZSH_VERSION" ]; then
    shell_rc="$HOME/.zshrc"
  elif [ -n "$BASH_VERSION" ]; then
    shell_rc="$HOME/.bashrc"
  else
    shell_rc="$HOME/.profile"
  fi
  
  local path_export="export PATH=\"\$HOME/.projectmind:\$PATH\""
  
  if ! grep -q "/.projectmind" "$shell_rc" 2>/dev/null; then
    echo "" >> "$shell_rc"
    echo "# ProjectMind Agent" >> "$shell_rc"
    echo "$path_export" >> "$shell_rc"
    print_success "Added to PATH in $shell_rc"
    print_warning "Run: source $shell_rc (or restart your terminal)"
  else
    print_info "PATH already configured in $shell_rc"
  fi
  
  # Also export for current session
  export PATH="$HOME/.projectmind:$PATH"
}

run_setup() {
  print_info "Running setup wizard..."
  echo ""
  
  # Change to install directory so .env is created there
  cd "$INSTALL_DIR"
  
  if [ -x "$INSTALL_DIR/$BINARY_NAME" ]; then
    "$INSTALL_DIR/$BINARY_NAME" setup
  else
    print_error "Binary not executable: $INSTALL_DIR/$BINARY_NAME"
    exit 1
  fi
}

setup_autostart() {
  echo ""
  read -p "Would you like to start the agent automatically at login? [y/N] " -n 1 -r
  echo ""
  
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    local plist_name="com.projectmind.agent"
    local plist_file="$HOME/Library/LaunchAgents/${plist_name}.plist"
    
    mkdir -p "$HOME/Library/LaunchAgents"
    
    cat > "$plist_file" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${plist_name}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_DIR}/${BINARY_NAME}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/agent.log</string>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/agent.error.log</string>
</dict>
</plist>
EOF
    
    # Load the plist
    launchctl unload "$plist_file" 2>/dev/null || true
    launchctl load "$plist_file"
    
    print_success "Configured to start at login"
    print_info "Logs will be written to $INSTALL_DIR/agent.log"
    print_info "To stop: launchctl unload $plist_file"
    print_info "To start manually: launchctl load $plist_file"
  fi
}

print_finish() {
  echo ""
  echo "╔═══════════════════════════════════════════════════════════╗"
  echo "║       Installation Complete!                              ║"
  echo "╚═══════════════════════════════════════════════════════════╝"
  echo ""
  print_success "ProjectMind Agent installed to: $INSTALL_DIR"
  echo ""
  echo "Commands:"
  echo "  $BINARY_NAME          # Start the agent"
  echo "  $BINARY_NAME doctor   # Check configuration"
  echo "  $BINARY_NAME help     # Show help"
  echo ""
  echo "To start now (if not using auto-start):"
  echo "  cd $INSTALL_DIR && ./$BINARY_NAME"
  echo ""
  print_info "Visit https://projectm.dev/docs for more information"
  echo ""
}

main() {
  print_header
  
  # Check if running on macOS
  if [ "$(uname)" != "Darwin" ]; then
    print_error "This installer is for macOS only."
    print_info "For other platforms, visit: https://projectm.dev/downloads"
    exit 1
  fi
  
  # Detect architecture
  local arch=$(detect_arch)
  print_info "Detected architecture: $arch"
  
  # Download
  local zip_file=$(download_agent "$arch")
  
  # Install
  install_agent "$zip_file"
  
  # Add to PATH
  add_to_path
  
  # Run setup wizard
  run_setup
  
  # Optional: setup auto-start
  setup_autostart
  
  # Show completion message
  print_finish
}

main
