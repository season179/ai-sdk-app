#!/usr/bin/env python3
"""PreToolUse(Bash) hook: nudge toward codedb when a command SEARCHES source.

Fires only when the *producer* (first pipe stage) of a command is a search tool
(grep/rg/ack/ag/fd, or `find ... -name`). Stays silent when grep merely filters
another command's output — `git ls-files | grep`, `cat f | grep`, `ps | grep` —
where codedb is irrelevant. Also gated on a codedb.snapshot existing in CWD.

Reads the PreToolUse payload as JSON on stdin; prints a hookSpecificOutput JSON
object on stdout when (and only when) the nudge applies. Never errors out the
tool: any parse failure or missing field just stays silent.
"""
import json
import os
import re
import sys

SEARCH = ("grep", "egrep", "fgrep", "rg", "ripgrep", "ack", "ag", "fd", "fdfind")

NUDGE = (
    "codedb is the primary code-intelligence tool here. Before grepping/finding "
    "raw files, use codedb MCP tools: `codedb_search` (trigram full-text/regex), "
    "`codedb_word` (identifier lookup), `codedb_symbol` (definitions), "
    "`codedb_callers`. Use graphify (`graphify query/path/explain`) only for "
    "architecture or cross-cutting/conceptual questions. Grep raw files only to "
    "modify/debug specific lines."
)


def is_search(stage):
    """True if this pipe stage *leads* with a source-search tool."""
    toks = stage.split()
    if not toks:
        return False
    prog = os.path.basename(toks[0])
    if prog in SEARCH:
        return True
    if prog == "find" and re.search(r"\s-(i?name|i?path|regex)\b", stage):
        return True
    return False


def wants_nudge(cmd):
    # Split into sequential commands (&& || ; newline); within each, the producer
    # is the first pipe stage. A search tool used as a pipe *consumer*
    # (`git ls-files | grep`) never becomes a producer, so it is not flagged.
    for command in re.split(r"&&|\|\||;|\n", cmd):
        if is_search(command.split("|")[0]):
            return True
    return False


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return
    cmd = str((data.get("tool_input", data) or {}).get("command", "") or "")
    if wants_nudge(cmd) and os.path.exists("codedb.snapshot"):
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": NUDGE,
        }}))


if __name__ == "__main__":
    main()
