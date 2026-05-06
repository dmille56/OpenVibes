{
  description = "OpenVibes development shell";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    llm-agents.url = "github:numtide/llm-agents.nix";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils, llm-agents }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in {
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.typescript
            llm-agents.packages.${system}.pi
          ];

          shellHook = ''
            export PI_CODING_AGENT_DIR="$PWD/.pi-agent"
            export HOME="$PWD/.pi-home"
            export XDG_CONFIG_HOME="$PWD/.xdg-config"
            export XDG_DATA_HOME="$PWD/.xdg-data"

            mkdir -p "$PI_CODING_AGENT_DIR" "$HOME" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"

            echo "OpenVibes dev shell ready: node $(node --version), tsc $(tsc --version)"
          '';
        };
      });
}
