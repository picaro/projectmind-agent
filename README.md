# ProjectMind Agent — Count Source Files Utility

A lightweight, robust Python utility to scan a directory recursively, count source files, and calculate lines of code (LOC). Files are grouped and summarized by extension.

## Features

- **Recursive Scanning**: Traverses nested directories to find source files.
- **Configurable Filters**: Excludes common package manager, configuration, and version control directories by default (e.g., `.git`, `node_modules`, `venv`, etc.).
- **Summary Statistics**: Displays file count, total lines of code, and average lines per file, formatted as a table and sorted by file count.
- **Detailed Log Options**: Supports printing details of every single scanned source file.

## Usage

### Run Default Scan
To scan the current directory with default extension and directory exclusions:
```bash
./count_files.py
```

### Scan a Specific Directory
```bash
./count_files.py /path/to/project
```

### Detailed Mode
Print each file path, extension, and its line count along with the summary:
```bash
./count_files.py --detailed
```

### Customize Exclusions and Extensions
Filter to only count specific file types:
```bash
./count_files.py --extensions py js ts
```

Add custom directory exclusions:
```bash
./count_files.py --exclude src/temp build_output
```

## Running Tests
Run the test suite with python's built-in `unittest` framework:
```bash
python3 -m unittest test_count_files.py
```