/** Shared release asset catalog for build-release and CI merge. */
export const NATIVE_TARGETS = [
  {
    id: "macos-arm64",
    label: "macOS (Apple Silicon)",
    os: "macos",
    arch: "arm64",
    pkgTarget: "node22-macos-arm64",
    binaryName: "projectmind-agent",
    zipName: "projectmind-agent-macos-arm64.zip",
  },
  {
    id: "macos-x64",
    label: "macOS (Intel)",
    os: "macos",
    arch: "x64",
    pkgTarget: "node22-macos-x64",
    binaryName: "projectmind-agent",
    zipName: "projectmind-agent-macos-x64.zip",
  },
  {
    id: "windows-x64",
    label: "Windows (x64)",
    os: "windows",
    arch: "x64",
    pkgTarget: "node22-win-x64",
    binaryName: "projectmind-agent.exe",
    zipName: "projectmind-agent-windows-x64.zip",
  },
  {
    id: "ubuntu-x64",
    label: "Ubuntu (x64)",
    os: "ubuntu",
    arch: "x64",
    pkgTarget: "node22-linux-x64",
    binaryName: "projectmind-agent",
    zipName: "projectmind-agent-ubuntu-x64.zip",
  },
];

export const NODEJS_TARGET = {
  id: "nodejs",
  label: "Node.js (cross-platform)",
  os: "nodejs",
  arch: "any",
  zipName: "projectmind-agent-nodejs.zip",
};

export const ALL_RELEASE_TARGETS = [...NATIVE_TARGETS, NODEJS_TARGET];

export function releaseReadme(version) {
  return `# ProjectMind desktop agent downloads

Version **${version}** (unsigned zip).

Includes native macOS / Windows / Ubuntu binaries and a **Node.js** cross-platform zip.

Each zip includes a **platform-specific \`README.txt\`** (how to run on that OS), plus a sample **\`.env\`** (and \`.env.example\`) pointed at \`https://projectm.dev/api/mcp\` — edit your API key and workspace allowlist before running.

| Zip | Run |
| --- | --- |
| macOS | \`./projectmind-agent\` (clear quarantine first) |
| Windows | \`.\\\\projectmind-agent.exe\` |
| Ubuntu | \`chmod +x ./projectmind-agent && ./projectmind-agent\` |
| Node.js | \`npm install && npm start\` (Node 22.13+; not bare \`npm run\`) |

**macOS trust:** after unzip, run \`xattr -dr com.apple.quarantine .\` (or double-click \`clear-quarantine.command\` in the macOS zip), or System Settings → Privacy & Security → Open Anyway.

Built by \`npm run build:release\` in the projectmind-agent repo.
`;
}
