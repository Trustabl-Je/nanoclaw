# sudo-preflight.sh — ask for the sudo password before setup hides it.
#
# Source after defining dim/red (nanoclaw.sh's status-line helpers), then
# pass nanoclaw.sh's arguments, which setup:auto reads too:
#
#   if ! sudo_preflight "$@"; then exit 1; fi
#
# On Linux, setup installs Node and Docker with sudo from inside steps whose
# output sits behind a spinner, so sudo's prompt can't be seen and times out.
# One `sudo -v` in the open caches the timestamp those later calls reuse.
# Uses bash builtins plus uname/id/node/sudo only: Node may not exist yet.

# The steps this run skips. As in setup:auto, --skip replaces NANOCLAW_SKIP.
sudo_preflight_skip() {
  local skip="${NANOCLAW_SKIP:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --) break ;;
      --skip=*) skip="${1#--skip=}" ;;
      --skip) [ $# -gt 1 ] && { skip="$2"; shift; } ;;
    esac
    shift
  done
  echo "$skip"
}

# What setup will install with sudo ("Node", "Docker" or "Node and Docker");
# exit 1 when nothing needs it. Takes nanoclaw.sh's arguments.
sudo_preflight_needs() {
  [ "$(uname -s 2>/dev/null)" = "Linux" ] || return 1
  [ "$(id -u 2>/dev/null)" != "0" ] || return 1
  local node="" docker="" version skip
  # setup/install-node.sh installs through uvx, without sudo, when it can.
  if ! command -v uvx >/dev/null 2>&1; then
    version=$(node --version 2>/dev/null || true)
    version=${version#v}
    [ "${version%%.*}" -ge 22 ] 2>/dev/null || node="Node"
  fi
  # A run that skips the container step never installs Docker.
  skip=",$(sudo_preflight_skip "$@"),"
  case "${skip// /}" in
    *,container,*) ;;
    *) command -v docker >/dev/null 2>&1 || docker="Docker" ;;
  esac
  if [ -n "$node" ] && [ -n "$docker" ]; then
    echo "Node and Docker"
  elif [ -n "$node$docker" ]; then
    echo "$node$docker"
  else
    return 1
  fi
}

# Someone at a terminal who can answer sudo. Without one, setup keeps its
# old behaviour rather than wait on a prompt nobody will see.
sudo_preflight_interactive() {
  [ -t 0 ] && (exec </dev/tty) 2>/dev/null
}

# Returns 1 only when sudo was needed and the user couldn't get it.
sudo_preflight() {
  local needs
  needs=$(sudo_preflight_needs "$@") || return 0
  command -v sudo >/dev/null 2>&1 || return 0
  sudo_preflight_interactive || return 0
  sudo -n true >/dev/null 2>&1 && return 0

  printf '  %s\n' "$(dim "Setup needs to install ${needs}, so it will ask for your Linux password (sudo).")"
  if sudo -v -p '  [sudo] password for %p: '; then
    printf '\n'
    return 0
  fi
  printf '\n  %s %s\n' "$(red '✗')" "Couldn't get sudo access to install ${needs}."
  printf '  %s\n\n' \
    "$(dim "Re-run bash nanoclaw.sh and enter your password, or install ${needs/Node/Node 22+} yourself first.")"
  return 1
}
