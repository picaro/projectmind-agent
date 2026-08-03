#!/usr/bin/env python3
import unittest
import os
import shutil
import tempfile
from count_files import count_source_files

class TestCountSourceFiles(unittest.TestCase):
    def setUp(self):
        # Create a temporary directory structure
        self.test_dir = tempfile.mkdtemp()
        
        # Create some dummy files
        os.makedirs(os.path.join(self.test_dir, "src"))
        os.makedirs(os.path.join(self.test_dir, "node_modules"))
        os.makedirs(os.path.join(self.test_dir, ".git"))
        
        # Valid source files
        self.write_file("src/main.py", "print('hello')\nprint('world')\n")
        self.write_file("src/utils.js", "console.log('test');\n")
        self.write_file("README.md", "# Project\n")
        
        # Ignored files or in ignored directories
        self.write_file("node_modules/package.js", "console.log('ignored');\n")
        self.write_file(".git/config", "[core]\n")
        self.write_file("src/data.dat", "binary data here")  # invalid extension

    def tearDown(self):
        # Clean up temporary directory
        shutil.rmtree(self.test_dir)

    def write_file(self, rel_path, content):
        path = os.path.join(self.test_dir, rel_path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)

    def test_default_counting(self):
        stats, detailed_files = count_source_files(self.test_dir)
        
        # We expect .py, .js, and .md to be counted (3 files total, ignoring node_modules, .git, and .dat file)
        self.assertIn('.py', stats)
        self.assertIn('.js', stats)
        self.assertIn('.md', stats)
        self.assertNotIn('.dat', stats)
        
        # .py file: main.py has 2 lines
        self.assertEqual(stats['.py'][0], 1)
        self.assertEqual(stats['.py'][1], 2)
        
        # .js file: utils.js has 1 line
        self.assertEqual(stats['.js'][0], 1)
        self.assertEqual(stats['.js'][1], 1)
        
        # .md file: README.md has 1 line
        self.assertEqual(stats['.md'][0], 1)
        self.assertEqual(stats['.md'][1], 1)
        
        # Total files in detailed_files list
        self.assertEqual(len(detailed_files), 3)

    def test_custom_extensions(self):
        # Only count .py files
        stats, detailed_files = count_source_files(self.test_dir, target_extensions=['.py'])
        self.assertEqual(len(stats), 1)
        self.assertIn('.py', stats)
        self.assertEqual(len(detailed_files), 1)

    def test_custom_ignored_dirs(self):
        # Custom ignore where we do NOT ignore node_modules
        stats, detailed_files = count_source_files(self.test_dir, ignore_dirs=['.git'])
        # Now node_modules/package.js should be counted as a JS file (making 2 JS files)
        self.assertEqual(stats['.js'][0], 2)

if __name__ == '__main__':
    unittest.main()
