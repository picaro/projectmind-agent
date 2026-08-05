#!/bin/bash
#
# ProjectMind Agent - Ubuntu/Linux Installer
# One-command installation script for Ubuntu and Debian-based Linux
#
# Usage: curl -fsSL https://projectm.dev/install-linux.sh | bash
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
  echo "║       ProjectMind Agent - Linux Installer                ║"
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
  if [ "$arch" = "x86_64" ]; then
    echo "ubuntu-x64"
  else
    print_error "Unsupported architecture: $arch"
    print_info "This installer supports x86_64 only."
    exit 1
  fi
}

check_glibc() {
  if ! command -v ldd >/dev/null 2>&1; then
    print_warning "Cannot verify glibc version"
    return
  fi
  
  local glibc_version=$(ldd --version | head -n1 | grep -oP '\d+\.\d+' | head -n1)
  print_info "Detected glibc version: $glibc_version"
  
  # Check if version is >= 2.27
  if [ "$(printf '%s\n' "2.27" "$glibc_version" | sort -V | head -n1)" != "2.27" ]; then
    print_warning "glibc version $glibc_version may be too old (need 2.27+)"
    print_info "Consider using the Node.js version: npm install -g projectmind-agent"
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
    print_info "Ubuntu/Debian: sudo apt-get install curl"
    print_info "Fedora/RHEL: sudo dnf install curl"
    exit 1
  fi
  
  print_success "Downloaded agent"
  echo "$temp_zip"
}

install_agent() {
  local zip_file=$1
  local temp_dir="/tmp/projectmind-agent-install"
  
  print_info "Installing to $INSTALL_DIR..."
  
  # Check for unzip
  if ! command -v unzip >/dev/null 2>&1; then
    print_error "unzip not found. Please install it:"
    print_info "Ubuntu/Debian: sudo apt-get install unzip"
    print_info "Fedora/RHEL: sudo dnf install unzip"
    exit 1
  fi
  
  # Clean up any existing temp directory
  rm -rf "$temp_dir"
  mkdir -p "$temp_dir"
  
  # Unzip
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

setup_systemd_service() {
  echo ""
  read -p "Would you like to start the agent automatically at boot (systemd)? [y/N] " -n 1 -r
  echo ""
  
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    local service_name="projectmind-agent"
    local service_file="$HOME/.config/systemd/user/${service_name}.service"
    
    mkdir -p "$HOME/.config/systemd/user"
    
    cat > "$service_file" << EOF
[Unit]
Description=ProjectMind Agent
After=network.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/${BINARY_NAME}
WorkingDirectory=${INSTALL_DIR}
Restart=on-failure
RestartSec=10
StandardOutput=append:${INSTALL_DIR}/agent.log
StandardError=append:${INSTALL_DIR}/agent.error.log

[Install]
WantedBy=default.target
EOF
    
    # Reload systemd and enable service
    systemctl --user daemon-reload
    systemctl --user enable "$service_name"
    systemctl --user start "$service_name"
    
    print_success "Configured systemd service"
    print_info "Service: $service_name"
    print_info "Status: systemctl --user status $service_name"
    print_info "Logs: journalctl --user -u $service_name -f"
    print_info "Stop: systemctl --user stop $service_name"
    print_info "Disable: systemctl --user disable $service_name"
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
  echo "To start now (if not using systemd):"
  echo "  cd $INSTALL_DIR && ./$BINARY_NAME"
  echo ""
  print_info "Visit https://projectm.dev/docs for more information"
  echo ""
}

main() {
  print_header
  
  # Check if running on Linux
  if [ "$(uname)" != "Linux" ]; then
    print_error "This installer is for Linux only."
    print_info "For other platforms, visit: https://projectm.dev/downloads"
    exit 1
  fi
  
  # Detect architecture
  local arch=$(detect_arch)
  print_info "Detected architecture: $arch"
  
  # Check glibc version
  check_glibc
  
  # Download
  local zip_file=$(download_agent "$arch")
  
  # Install
  install_agent "$zip_file"
  
  # Add to PATH
  add_to_path
  
  # Run setup wizard
  run_setup
  
  # Optional: setup systemd service
  if command -v systemctl >/dev/null 2>&1; then
    setup_systemd_service
  else
    print_warning "systemd not found - skipping auto-start setup"
  fi
  
  # Show completion message
  print_finish
}

main
