#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# rig / bootstrap.sh
# Instala rig en un equipo nuevo desde cero.
# Uso: curl -fsSL https://raw.githubusercontent.com/ccosming/rig/main/bootstrap.sh | bash
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

RIG_REPO="https://github.com/TU_USUARIO/rig.git"
RIG_DIR="$HOME/.rig"

# ─── Colores ─────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
info() { echo -e "  ${CYAN}→${RESET} $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; exit 1; }

# ─── Header ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}  rig bootstrap${RESET} ${DIM}— machine provisioning${RESET}"
echo -e "${DIM}  ──────────────────────────────────────${RESET}"
echo ""

# ─── macOS check ─────────────────────────────────────────────────────────────
if [[ "$OSTYPE" != "darwin"* ]]; then
  fail "bootstrap.sh only supports macOS for now."
fi

# ─── 1. Xcode Command Line Tools ─────────────────────────────────────────────
info "Checking Xcode Command Line Tools..."
if ! xcode-select -p &>/dev/null; then
  warn "Installing Xcode Command Line Tools..."
  xcode-select --install
  echo "  Re-run bootstrap.sh after the installation completes."
  exit 0
fi
ok "Xcode CLT"

# ─── 2. Homebrew ─────────────────────────────────────────────────────────────
info "Checking Homebrew..."
if ! command -v brew &>/dev/null; then
  warn "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # Apple Silicon path
  if [[ -f "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi
ok "Homebrew $(brew --version | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

# ─── 3. Git ──────────────────────────────────────────────────────────────────
info "Checking git..."
if ! command -v git &>/dev/null; then
  brew install git
fi
ok "git"

# ─── 4. Node.js via proto ────────────────────────────────────────────────────
info "Checking proto..."
if ! command -v proto &>/dev/null; then
  warn "Installing proto..."
  brew install proto
fi
ok "proto"

info "Checking Node.js..."
if ! command -v node &>/dev/null; then
  warn "Installing Node.js via proto..."
  proto install node
fi
ok "node $(node --version)"

# ─── 5. pnpm via proto ───────────────────────────────────────────────────────
info "Checking pnpm..."
if ! command -v pnpm &>/dev/null; then
  warn "Installing pnpm via proto..."
  proto install pnpm
fi
ok "pnpm"

# ─── 6. chezmoi ──────────────────────────────────────────────────────────────
info "Checking chezmoi..."
if ! command -v chezmoi &>/dev/null; then
  warn "Installing chezmoi..."
  brew install chezmoi
fi
ok "chezmoi"

# ─── 7. Clonar rig ───────────────────────────────────────────────────────────
info "Checking rig..."
if [[ -d "$RIG_DIR" ]]; then
  warn "~/.rig already exists — pulling latest..."
  git -C "$RIG_DIR" pull --ff-only
else
  info "Cloning rig into ~/.rig..."
  git clone "$RIG_REPO" "$RIG_DIR"
fi
ok "rig cloned at $RIG_DIR"

# ─── 8. Instalar dependencias y linkear CLI ──────────────────────────────────
info "Installing rig dependencies..."
cd "$RIG_DIR"
pnpm install --frozen-lockfile
pnpm build
npm link
ok "rig CLI linked"

# ─── 9. Inicializar chezmoi apuntando a rig/dotfiles ─────────────────────────
info "Initializing chezmoi..."
if [[ ! -d "$HOME/.local/share/chezmoi" ]]; then
  chezmoi init --source "$RIG_DIR/dotfiles"
  ok "chezmoi initialized"
else
  warn "chezmoi already initialized — skipping"
fi

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${DIM}  ──────────────────────────────────────${RESET}"
echo ""
echo -e "  ${GREEN}Bootstrap complete.${RESET}"
echo ""
echo -e "  Next steps:"
echo -e "    ${CYAN}rig doctor${RESET}   — verify your environment"
echo -e "    ${CYAN}rig install${RESET}  — install your tools"
echo -e "    ${CYAN}rig sync${RESET}     — apply your dotfiles"
echo ""
