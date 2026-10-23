package main

// Which copy may write the board's folder: board.mjs's writeRefusal, for what this binary writes
// (an ack line, its note). Outside the account's home (and /root, and JOB_BOARD_PROTECT's
// folders): any copy. Inside: the copy Herdr installed (a binary under Herdr's plugins folder),
// or, with JOB_BOARD_DEV=1, a folder of its own (JOB_BOARD_HOME / JOB_BOARD_FILE) that is not the
// machine's one board nor a repo's .git. So a development build never writes the live inbox; it
// still reads it. A copy in Claude Code's plugin cache counts as installed too. Under the test
// harness (JOB_BOARD_TEST_SANDBOX) only its folders.

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strings"
)

func realOr(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		return r
	}
	return filepath.Clean(p)
}

func inside(path, root string) bool {
	return path == root || strings.HasPrefix(path, root+string(filepath.Separator))
}

func accountHome() string {
	if u, err := user.Current(); err == nil && u.HomeDir != "" {
		return u.HomeDir
	}
	return "/root"
}

// pluginDirs are Herdr's plugin folders (board.mjs pluginDirs).
func pluginDirs(env func(string) string) []string {
	var configs []string
	if c := env("HERDR_CONFIG_PATH"); c != "" {
		if abs, err := filepath.Abs(c); err == nil {
			configs = append(configs, filepath.Dir(abs))
		}
	}
	if x := env("XDG_CONFIG_HOME"); x != "" {
		configs = append(configs, filepath.Join(x, "herdr"))
	}
	if h := env("HOME"); h != "" && filepath.IsAbs(h) {
		configs = append(configs, filepath.Join(h, ".config", "herdr"))
	}
	configs = append(configs, filepath.Join(accountHome(), ".config", "herdr"))
	var out []string
	for _, c := range configs {
		out = append(out, realOr(filepath.Join(c, "plugins")))
	}
	return out
}

// claudePluginDirs are Claude Code's plugin caches, where a plugin installed from a marketplace
// runs from: plugins/cache in CLAUDE_CONFIG_DIR, else ~/.claude.
func claudePluginDirs(env func(string) string) []string {
	var out []string
	if c := env("CLAUDE_CONFIG_DIR"); c != "" && filepath.IsAbs(c) {
		out = append(out, realOr(filepath.Join(c, "plugins", "cache")))
	}
	out = append(out, realOr(filepath.Join(accountHome(), ".claude", "plugins", "cache")))
	return out
}

// installed says whether binary `exe` is in a copy Herdr installed (or Claude Code's plugin cache).
func installed(exe string, env func(string) string) bool {
	here := realOr(exe)
	for _, d := range append(pluginDirs(env), claudePluginDirs(env)...) {
		if inside(here, d) && here != d {
			return true
		}
	}
	return false
}

// WriteRefusal is "" when this binary may write into board folder `dir`, else why not.
func WriteRefusal(dir, exe string, env func(string) string) string {
	target := realOr(dir)
	if roots := env("JOB_BOARD_TEST_SANDBOX"); roots != "" {
		ok := false
		for _, r := range strings.Split(roots, ":") {
			if r != "" && strings.HasPrefix(target+string(filepath.Separator), r+string(filepath.Separator)) {
				ok = true
			}
		}
		if !ok {
			return fmt.Sprintf("test sandbox: refusing to touch %s", target)
		}
	}
	account := realOr(accountHome())
	roots := []string{account, "/root"}
	for _, p := range strings.Split(env("JOB_BOARD_PROTECT"), ":") {
		if p != "" {
			roots = append(roots, realOr(p))
		}
	}
	var root string
	for _, r := range roots {
		if inside(target, r) {
			root = r
			break
		}
	}
	if root == "" {
		return ""
	}
	if installed(exe, env) {
		return ""
	}
	oneBoard := []string{realOr(filepath.Join(account, ".local", "state", pluginID))}
	if d, err := StoreDir(func(k string) string {
		if k == "JOB_BOARD_HOME" {
			return ""
		}
		return env(k)
	}); err == nil {
		oneBoard = append(oneBoard, realOr(d))
	}
	own := env("JOB_BOARD_HOME") != "" || env("JOB_BOARD_FILE") != ""
	if env("JOB_BOARD_DEV") == "1" && own && !strings.Contains(target, string(filepath.Separator)+".git"+string(filepath.Separator)) && !strings.HasSuffix(target, string(filepath.Separator)+".git") {
		mine := true
		for _, d := range oneBoard {
			if inside(target, d) {
				mine = false
			}
		}
		if mine {
			return ""
		}
	}
	return fmt.Sprintf("this build (%s) isn't the installed plugin: it writes nothing under %s (%s); for a trial, set JOB_BOARD_HOME to a scratch folder", exe, root, target)
}

func exePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	return exe
}
