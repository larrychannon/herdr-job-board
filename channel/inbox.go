package main

// The board's inbox, as board.mjs keeps it (0.8.0): inbox.jsonl in the board's folder, a line per
// message { id, at, slug, kind, card, project, workspace, owner, pane, key, text, … } and a line
// per ack { ack: [ids], at, by }. Writers append under inbox.jsonl.lock, a directory with an
// "owner" file ("<pid> <host> <token>"), exactly as board.mjs's withLock does, so the two never
// write at once. Readers take the file without the lock and skip a line cut short.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	pluginID   = "herdr-job-board"
	inboxFile  = "inbox.jsonl"
	lockWait   = 10 * time.Second
	lockStale  = 10 * time.Second
	channelDir = "channels"
	// A note not renewed for this long (3 beats) is stale, whatever its process.
	noteFresh = 90 * time.Second
)

// Message is one inbox line that isn't an ack. Card is a number, or null.
type Message struct {
	ID        string          `json:"id"`
	At        string          `json:"at"`
	Slug      string          `json:"slug"`
	Kind      string          `json:"kind"`
	Card      json.RawMessage `json:"card"`
	Project   string          `json:"project"`
	Workspace string          `json:"workspace"`
	To        string          `json:"to"`
	Label     string          `json:"label"`
	Text      string          `json:"text"`
}

// CardID is the message's card as text ("" when it has none).
func (m Message) CardID() string {
	s := strings.TrimSpace(string(m.Card))
	if s == "" || s == "null" {
		return ""
	}
	if _, err := strconv.Atoi(s); err != nil {
		return ""
	}
	return s
}

// StoreDir is the board's folder: JOB_BOARD_HOME, else ${XDG_STATE_HOME:-~/.local/state}/herdr-job-board.
func StoreDir(env func(string) string) (string, error) {
	if h := env("JOB_BOARD_HOME"); h != "" {
		return filepath.Abs(h)
	}
	if x := env("XDG_STATE_HOME"); x != "" && filepath.IsAbs(x) {
		return filepath.Join(x, pluginID), nil
	}
	home := env("HOME")
	if home == "" || !filepath.IsAbs(home) {
		return "", errors.New("HOME is not an absolute path: set HOME (or JOB_BOARD_HOME)")
	}
	return filepath.Join(home, ".local", "state", pluginID), nil
}

// SideDir is where the inbox lives for board file `file`: its folder for board.json, else <name>.d.
func SideDir(file string) string {
	if filepath.Base(file) == "board.json" {
		return filepath.Dir(file)
	}
	return filepath.Join(filepath.Dir(file), strings.TrimSuffix(filepath.Base(file), ".json")+".d")
}

// BoardDir is the folder of the board the CLI would use: JOB_BOARD_FILE's side folder, else the store.
func BoardDir(env func(string) string) (string, error) {
	if f := env("JOB_BOARD_FILE"); f != "" {
		abs, err := filepath.Abs(f)
		if err != nil {
			return "", err
		}
		return SideDir(abs), nil
	}
	return StoreDir(env)
}

// Inbox is the parsed file: the messages in order, and the acked ids.
type Inbox struct {
	Messages []Message
	Acked    map[string]bool
}

// ReadInbox reads dir's inbox.jsonl; a missing file is an empty inbox.
func ReadInbox(dir string) (Inbox, error) {
	in := Inbox{Acked: map[string]bool{}}
	data, err := os.ReadFile(filepath.Join(dir, inboxFile))
	if errors.Is(err, os.ErrNotExist) {
		return in, nil
	}
	if err != nil {
		return in, err
	}
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var probe map[string]json.RawMessage
		if json.Unmarshal(line, &probe) != nil {
			continue
		}
		if raw, ok := probe["ack"]; ok {
			var ids []json.RawMessage
			if json.Unmarshal(raw, &ids) == nil {
				for _, id := range ids {
					var s string
					if json.Unmarshal(id, &s) != nil {
						s = strings.TrimSpace(string(id))
					}
					in.Acked[s] = true
				}
			}
			continue
		}
		var m Message
		if json.Unmarshal(line, &m) != nil || m.ID == "" {
			continue
		}
		var text string
		if json.Unmarshal(probe["text"], &text) != nil {
			continue
		}
		in.Messages = append(in.Messages, m)
	}
	return in, nil
}

// For says whether message m is for a coordinator in `workspace` (board.mjs inboxFor): every
// message without a workspace on either side, else only its own workspace's.
func For(m Message, workspace string) bool {
	return workspace == "" || m.Workspace == "" || m.Workspace == workspace
}

// ForPane says whether message m is for the coordinator in `pane`: a message addressed to one
// pane (`to`, a button's answer) there, or anywhere in its workspace once no channel runs in
// that pane any more (its coordinator was restarted in a new pane); every other message in
// every pane of its workspace. `live` is the panes with a live channel (LivePanes).
func ForPane(m Message, pane string, live map[string]bool) bool {
	return m.To == "" || pane == "" || m.To == pane || !live[m.To]
}

// LiveNotes is the channels running now (their notes): this host's whose process is alive and
// whose note was renewed within noteFresh. Others' stale notes are left for their owners.
func LiveNotes(dir string, now time.Time) []Note {
	entries, err := os.ReadDir(filepath.Join(dir, channelDir))
	if err != nil {
		return nil
	}
	var out []Note
	host := hostname()
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, channelDir, e.Name()))
		if err != nil {
			continue
		}
		var n Note
		if json.Unmarshal(data, &n) != nil || n.PID <= 0 || n.Host != host || !alive(n.PID) {
			continue
		}
		at, err := time.Parse(time.RFC3339Nano, n.At)
		if err != nil || now.Sub(at) > noteFresh {
			continue
		}
		out = append(out, n)
	}
	return out
}

// LivePanes is the panes of LiveNotes.
func LivePanes(dir string, now time.Time) map[string]bool {
	live := map[string]bool{}
	for _, n := range LiveNotes(dir, now) {
		if n.Pane != "" {
			live[n.Pane] = true
		}
	}
	return live
}

// Unacked is the messages for `workspace` not acked yet, oldest first.
func (in Inbox) Unacked(workspace string) []Message {
	var out []Message
	for _, m := range in.Messages {
		if !in.Acked[m.ID] && For(m, workspace) {
			out = append(out, m)
		}
	}
	return out
}

// --- the lock: board.mjs's withLock, the same directory and owner file ---------------------------

func hostname() string {
	h, _ := os.Hostname()
	return h
}

func alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func token() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%d %s %s", os.Getpid(), hostname(), hex.EncodeToString(b))
}

type lockState struct {
	ino   uint64
	mtime time.Time
	owner string
}

func lockInfo(lock string) (lockState, bool) {
	st, err := os.Stat(lock)
	if err != nil {
		return lockState{}, false
	}
	var ino uint64
	if s, ok := st.Sys().(*syscall.Stat_t); ok {
		ino = uint64(s.Ino)
	}
	owner, _ := os.ReadFile(filepath.Join(lock, "owner"))
	return lockState{ino: ino, mtime: st.ModTime(), owner: strings.TrimSpace(string(owner))}, true
}

// A lock is stale when its owner on this host is gone; with no owner yet, or one on another
// host, after lockStale.
func stale(info lockState) bool {
	parts := strings.Fields(info.owner)
	if len(parts) >= 2 {
		if pid, err := strconv.Atoi(parts[0]); err == nil && pid > 0 && parts[1] == hostname() {
			return !alive(pid)
		}
	}
	return time.Since(info.mtime) > lockStale
}

// reap removes the stale lock it judged, and only that one (moved aside, then checked by inode).
func reap(lock string, info lockState) {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	aside := fmt.Sprintf("%s.%d.%s.stale", lock, os.Getpid(), hex.EncodeToString(b))
	if os.Rename(lock, aside) != nil {
		return
	}
	if now, ok := lockInfo(aside); !ok || now.ino != info.ino {
		if os.Rename(aside, lock) == nil {
			return
		}
	}
	_ = os.RemoveAll(aside)
}

// WithLock runs fn holding `file`.lock.
func WithLock(file string, fn func() error) error {
	lock := file + ".lock"
	tok := token()
	start := time.Now()
	for {
		err := os.Mkdir(lock, 0o700)
		if err == nil {
			if werr := os.WriteFile(filepath.Join(lock, "owner"), []byte(tok), 0o600); werr != nil {
				_ = os.RemoveAll(lock)
				return werr
			}
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		info, ok := lockInfo(lock)
		if !ok {
			continue
		}
		if stale(info) {
			reap(lock, info)
			continue
		}
		if time.Since(start) > lockWait {
			return fmt.Errorf("the inbox is locked (%s); remove that directory if no board command is running", lock)
		}
		time.Sleep(time.Duration(5+time.Now().UnixNano()%30) * time.Millisecond)
	}
	defer func() {
		if info, ok := lockInfo(lock); ok && info.owner == tok {
			_ = os.RemoveAll(lock)
		}
	}()
	return fn()
}

// AckResult is what Ack did: the ids it acked, the ones it doesn't know, the ones acked before.
type AckResult struct {
	Acked   []string `json:"acked"`
	Unknown []string `json:"unknown"`
	Already []string `json:"already"`
}

// Ack marks `ids` (or, with all, every unacked message for `workspace`) as handled: one ack line,
// under the inbox's lock. Compacting the file is left to board.mjs.
func Ack(dir string, ids []string, all bool, workspace, by string, now time.Time) (AckResult, error) {
	res := AckResult{Acked: []string{}, Unknown: []string{}, Already: []string{}}
	path := filepath.Join(dir, inboxFile)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return res, err
	}
	err := WithLock(path, func() error {
		in, err := ReadInbox(dir)
		if err != nil {
			return err
		}
		known := map[string]bool{}
		for _, m := range in.Messages {
			known[m.ID] = true
		}
		var want []string
		if all {
			for _, m := range in.Unacked(workspace) {
				want = append(want, m.ID)
			}
		} else {
			seen := map[string]bool{}
			for _, id := range ids {
				id = strings.TrimPrefix(strings.TrimSpace(id), "#")
				if id != "" && !seen[id] {
					seen[id] = true
					want = append(want, id)
				}
			}
		}
		for _, id := range want {
			switch {
			case !known[id]:
				res.Unknown = append(res.Unknown, id)
			case in.Acked[id]:
				res.Already = append(res.Already, id)
			default:
				res.Acked = append(res.Acked, id)
			}
		}
		if len(res.Acked) == 0 {
			return nil
		}
		rec := map[string]any{"ack": res.Acked, "at": now.UTC().Format("2006-01-02T15:04:05.000Z")}
		if by != "" {
			rec["by"] = by
		}
		line, _ := json.Marshal(rec)
		f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
		if err != nil {
			return err
		}
		if _, err := f.Write(append(line, '\n')); err != nil {
			f.Close()
			return err
		}
		return f.Close()
	})
	return res, err
}

// --- the channel's note: channels/<pid>.json while it runs ---------------------------------------
//
// board.mjs reads these to know a coordinator pane has the channel (a button press then goes to
// the inbox instead of being typed) and that someone hears the inbox. `at` is renewed every
// beatEvery; a note whose process is gone, or that wasn't renewed for a while, is stale.

// Note is the channel's record.
type Note struct {
	PID       int    `json:"pid"`
	Host      string `json:"host"`
	At        string `json:"at"`
	Started   string `json:"started"`
	Pane      string `json:"pane"`
	Workspace string `json:"workspace"`
	Version   string `json:"version"`
}

// WriteNote writes (or renews) this process's note, atomically.
func WriteNote(dir string, n Note) (string, error) {
	nd := filepath.Join(dir, channelDir)
	if err := os.MkdirAll(nd, 0o700); err != nil {
		return "", err
	}
	path := filepath.Join(nd, strconv.Itoa(n.PID)+".json")
	data, _ := json.Marshal(n)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return "", err
	}
	return path, os.Rename(tmp, path)
}
