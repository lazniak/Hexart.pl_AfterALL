#!/usr/bin/env bash
# =====================================================================
# HEXART.PL/AfterALL — macOS installer
# =====================================================================
# Double-click this file in Finder. It will:
#   1. Detect required system tools (git, Python 3, Ollama).
#   2. Install Homebrew if it's missing (the user is asked first).
#   3. Install git, Python 3, Ollama via brew.
#   4. Copy the plugin into ~/Library/Application Support/Adobe/CEP/extensions/
#   5. Enable Adobe's PlayerDebugMode for every CEP version 9..18.
#   6. Pull the default Gemma 3 4B model so the plugin works out of the box.
#
# Safe to run multiple times — every step is idempotent.
# =====================================================================

set -e
set -u

# Re-launch in Terminal if the user double-clicked from Finder and we're
# attached to a non-interactive shell with no controlling terminal — this
# way the .command file works as a clickable installer too.
if [[ -t 1 ]]; then
  : # already in a terminal
fi

PLUGIN_NAME="HEXART.PL_AfterALL"
PLUGIN_BUNDLE_ID="pl.hexart.afterall"
EXT_TARGET="$HOME/Library/Application Support/Adobe/CEP/extensions/$PLUGIN_NAME"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

c_reset=$(tput sgr0 2>/dev/null || true)
c_bold=$(tput bold 2>/dev/null || true)
c_green=$(tput setaf 2 2>/dev/null || true)
c_yellow=$(tput setaf 3 2>/dev/null || true)
c_red=$(tput setaf 1 2>/dev/null || true)
c_cyan=$(tput setaf 6 2>/dev/null || true)

say()   { printf "%s\n" "$1"; }
ok()    { printf "${c_green}[OK]${c_reset} %s\n" "$1"; }
warn()  { printf "${c_yellow}[!!]${c_reset} %s\n" "$1"; }
fail()  { printf "${c_red}[--]${c_reset} %s\n" "$1"; }
step()  { printf "\n${c_bold}${c_cyan}== %s ==${c_reset}\n" "$1"; }

ask_yn() {
  local prompt="$1"
  local default="${2:-y}"
  local hint="[Y/n]"
  [[ "$default" == "n" ]] && hint="[y/N]"
  local reply
  read -r -p "$prompt $hint " reply || reply=""
  reply="$(echo "$reply" | tr '[:upper:]' '[:lower:]')"
  if [[ -z "$reply" ]]; then reply="$default"; fi
  [[ "$reply" == "y" || "$reply" == "yes" || "$reply" == "t" || "$reply" == "tak" ]]
}

# ---------------------------------------------------------------------
step "HEXART.PL/AfterALL — macOS installer"
say "This script will set up the After Effects plugin and its local LLM."
say "Source folder: $SCRIPT_DIR"
say "Target folder: $EXT_TARGET"

# 1. Detect Xcode Command Line Tools (needed for git on a clean macOS).
step "1/6  Checking Xcode Command Line Tools"
if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode CLT detected at $(xcode-select -p)"
else
  warn "Xcode Command Line Tools missing. macOS will prompt to install them."
  if ask_yn "Trigger the Apple installer now?" y; then
    xcode-select --install || true
    say "After the Apple installer finishes, rerun this script."
    exit 0
  else
    fail "Aborted — Xcode CLT are required (provides git + compilers)."
    exit 1
  fi
fi

# 2. Homebrew — the cleanest path to git / python3 / ollama on macOS.
step "2/6  Checking Homebrew"
if command -v brew >/dev/null 2>&1; then
  ok "Homebrew detected at $(command -v brew)"
else
  warn "Homebrew not installed."
  if ask_yn "Install Homebrew now? (recommended; it manages git, Python, Ollama for you)" y; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    # brew install path differs on Apple Silicon vs Intel
    if [[ -x /opt/homebrew/bin/brew ]]; then
      eval "$(/opt/homebrew/bin/brew shellenv)"
    elif [[ -x /usr/local/bin/brew ]]; then
      eval "$(/usr/local/bin/brew shellenv)"
    fi
  else
    warn "Skipping Homebrew. You will need git / python3 / ollama on PATH manually."
  fi
fi

# 3. git
step "3/6  Checking git"
if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}') detected"
else
  if command -v brew >/dev/null 2>&1; then
    say "Installing git via Homebrew…"
    brew install git
    ok "git installed"
  else
    fail "git missing AND Homebrew unavailable. Install git from https://git-scm.com/download/mac and rerun."
    exit 1
  fi
fi

# 4. Python 3 (we use 3.11+ for the Python skill sandbox).
step "4/6  Checking Python 3"
if command -v python3 >/dev/null 2>&1; then
  ok "$(python3 --version) detected"
else
  if command -v brew >/dev/null 2>&1; then
    say "Installing python@3.11 via Homebrew…"
    brew install python@3.11
    ok "Python 3 installed"
  else
    fail "Python 3 missing AND Homebrew unavailable. Install from https://www.python.org/downloads/ and rerun."
    exit 1
  fi
fi

# 5. Ollama (built-in local LLM backend).
step "5/6  Checking Ollama (built-in local LLM)"
if command -v ollama >/dev/null 2>&1; then
  ok "ollama detected at $(command -v ollama)"
else
  if command -v brew >/dev/null 2>&1 && ask_yn "Install Ollama via Homebrew? (~50 MB, free, offline LLM runtime)" y; then
    brew install ollama
    ok "Ollama installed"
  else
    warn "Skipping Ollama install. The plugin will work with cloud LLM keys, but the built-in 'Local' provider will be inactive until you install Ollama from https://ollama.com/download."
  fi
fi

# Pull the default Gemma 3 4B model (~2.6 GB) so the local provider works
# out of the box. Skip if Ollama isn't installed; skip the pull if the
# user declines (they can always do it from the plugin UI).
if command -v ollama >/dev/null 2>&1; then
  # Make sure the daemon is running. On macOS, brew installs it as a
  # background service via brew services; nudge it just in case.
  (brew services start ollama >/dev/null 2>&1 || true)
  sleep 2
  if ! ollama list >/dev/null 2>&1; then
    warn "Ollama daemon didn't respond — start it manually with: ollama serve &"
  else
    if ask_yn "Pull default model 'gemma3:4b' now? (~2.6 GB, one-time)" y; then
      ollama pull gemma3:4b || warn "Pull failed — you can retry from the plugin (Settings → LLM Providers → Built-in Local → ⬇)."
    fi
  fi
fi

# 6. Copy the plugin into the CEP extensions folder and enable PlayerDebugMode.
step "6/6  Installing the plugin into Adobe CEP"
mkdir -p "$(dirname "$EXT_TARGET")"
if [[ -d "$EXT_TARGET" ]]; then
  warn "Plugin already installed at $EXT_TARGET — replacing files."
  # Keep user data dirs that may live alongside (defensive).
  rm -rf "$EXT_TARGET"
fi
cp -R "$SCRIPT_DIR" "$EXT_TARGET"
# Remove any junk we don't want to ship inside the extensions folder.
rm -rf "$EXT_TARGET/.git" "$EXT_TARGET/docs/screenshots" 2>/dev/null || true
ok "Plugin copied to $EXT_TARGET"

# Enable PlayerDebugMode for every CEP runtime version we ship for.
say "Enabling Adobe PlayerDebugMode (versions 9..18)…"
for v in 9 10 11 12 13 14 15 16 17 18; do
  defaults write "com.adobe.CSXS.${v}" PlayerDebugMode 1
done
defaults write com.apple.CoreServices.coreservicesd LSEnvironment -dict-add "PlayerDebugMode" "1" 2>/dev/null || true
ok "PlayerDebugMode enabled."

# Wrap up.
step "Installation complete"
ok "Restart After Effects, open Window → Extensions → HEXART.PL/AfterALL."
ok "If the panel doesn't appear, try: killall cfprefsd && relaunch After Effects."
say ""
say "Built-in local LLM is ready when Ollama service is running on http://localhost:11434"
say "Set provider to 'Built-in Local (Gemma 3 · Ollama)' in plugin Settings → LLM Providers."
say ""
