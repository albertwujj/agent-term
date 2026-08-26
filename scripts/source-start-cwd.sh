#!/usr/bin/env bash

agent_term_require_source_start_cwd() {
  if [[ -z "${INIT_CWD:-}" ]]; then
    echo "AgentTerm source launch requires npm's INIT_CWD." >&2
    echo 'Run npm from the intended workspace, using --prefix to select the AgentTerm checkout when needed.' >&2
    return 1
  fi
  if [[ "$INIT_CWD" != /* ]]; then
    echo "AgentTerm source launch directory is not absolute: $INIT_CWD" >&2
    return 1
  fi
  if [[ ! -d "$INIT_CWD" ]]; then
    echo "AgentTerm source launch directory does not exist: $INIT_CWD" >&2
    return 1
  fi

  export AGENT_TERM_START_CWD="$INIT_CWD"
}
