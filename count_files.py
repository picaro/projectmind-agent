#!/usr/bin/env python3
import os
import argparse
from collections import defaultdict

# Common source file extensions
DEFAULT_EXTENSIONS = {
    # Programming Languages
    '.py', '.js', '.ts', '.tsx', '.jsx', '.go', '.rs', '.java', '.c', '.cpp', 
    '.h', '.hpp', '.cs', '.swift', '.kt', '.rb', '.php', '.pl', '.sh', '.bat',
    '.ps1', '.sql', '.r', '.m', '.scala', '.lhs', '.hs', '.erl', '.hrl',
    # Markup & Config Languages
    '.html', '.css', '.scss', '.sass', '.less', '.xml', '.json', '.yaml', 
    '.yml', '.toml', '.ini', '.md', '.markdown', '.rst', '.gradle'
}

# Directories to ignore by default
DEFAULT_IGNORE_DIRS = {
    '.git', '.github', 'node_modules', 'venv', '.venv', 'env', '.env',
    '__pycache__', 'dist', 'build', 'out', '.next', '.vercel', '.idea',
    '.vscode', 'target', 'bin', 'obj', 'vendor'
}

def count_source_files(root_dir, target_extensions=None, ignore_dirs=None):
    """
    Recursively counts source files and lines of code in the root_dir.
    """
    if target_extensions is None:
        target_extensions = DEFAULT_EXTENSIONS
    else:
        target_extensions = set(target_extensions)

    if ignore_dirs is None:
        ignore_dirs = DEFAULT_IGNORE_DIRS
    else:
        ignore_dirs = set(ignore_dirs)

    # Dictionary to store results: extension -> (file_count, line_count)
    stats = defaultdict(lambda: [0, 0])
    detailed_files = []

    for dirpath, dirnames, filenames in os.walk(root_dir):
        # Modify dirnames in-place to skip ignored directories
        dirnames[:] = [d for d in dirnames if d not in ignore_dirs]

        for filename in filenames:
            _, ext = os.path.splitext(filename)
            ext = ext.lower()

            if ext in target_extensions:
                filepath = os.path.join(dirpath, filename)
                rel_path = os.path.relpath(filepath, root_dir)
                
                # Count lines of code
                lines = 0
                try:
                    with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                        lines = sum(1 for _ in f)
                except Exception:
                    # If we can't read it (e.g. permission or binary-like with text extension), skip line counting
                    pass

                stats[ext][0] += 1
                stats[ext][1] += lines
                detailed_files.append((rel_path, ext, lines))

    return stats, detailed_files

def main():
    parser = argparse.ArgumentParser(
        description="Count source files and lines of code in a directory tree."
    )
    parser.add_argument(
        'path', 
        nargs='?', 
        default='.', 
        help="Path to the directory to scan (default: current directory)."
    )
    parser.add_argument(
        '--exclude', 
        nargs='*', 
        help="Additional directories to ignore."
    )
    parser.add_argument(
        '--extensions', 
        nargs='*', 
        help="Only count these specific extensions (e.g., .py .js)."
    )
    parser.add_argument(
        '--detailed', 
        action='store_true', 
        help="Print a detailed list of all scanned source files."
    )
    args = parser.parse_args()

    # Validate target directory
    if not os.path.isdir(args.path):
        print(f"Error: '{args.path}' is not a valid directory.")
        return

    # Set up filters
    ignore_dirs = DEFAULT_IGNORE_DIRS.copy()
    if args.exclude:
        for d in args.exclude:
            ignore_dirs.add(d)

    extensions = DEFAULT_EXTENSIONS
    if args.extensions:
        # Standardize extensions to start with a dot
        extensions = {ext if ext.startswith('.') else f'.{ext}' for ext in args.extensions}

    print(f"Scanning directory: {os.path.abspath(args.path)}")
    print(f"Ignoring directories: {', '.join(sorted(ignore_dirs))}\n")

    stats, detailed_files = count_source_files(args.path, extensions, ignore_dirs)

    if not stats:
        print("No source files found matching the criteria.")
        return

    # Print detailed list if requested
    if args.detailed:
        print("Detailed File List:")
        print(f"{'File Path':<60} | {'Ext':<6} | {'Lines':<8}")
        print("-" * 80)
        for rel_path, ext, lines in sorted(detailed_files, key=lambda x: x[0]):
            print(f"{rel_path:<60} | {ext:<6} | {lines:<8}")
        print("\n" + "="*80 + "\n")

    # Print summary table
    print("Summary of Source Files:")
    print(f"{'Extension':<12} | {'File Count':<12} | {'Total Lines':<12} | {'Avg Lines/File':<15}")
    print("-" * 60)
    
    total_files = 0
    total_lines = 0

    for ext, (count, lines) in sorted(stats.items(), key=lambda x: x[1][0], reverse=True):
        avg_lines = lines / count if count > 0 else 0
        print(f"{ext:<12} | {count:<12} | {lines:<12} | {avg_lines:<15.1f}")
        total_files += count
        total_lines += lines

    print("-" * 60)
    avg_total_lines = total_lines / total_files if total_files > 0 else 0
    print(f"{'Total':<12} | {total_files:<12} | {total_lines:<12} | {avg_total_lines:<15.1f}")

if __name__ == '__main__':
    main()
