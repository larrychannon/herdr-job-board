package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func writeLines(t *testing.T, dir string, lines ...string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, inboxFile), []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReadInboxSkipsBrokenLinesAndReadsAcks(t *testing.T) {
	dir := t.TempDir()
	writeLines(t, dir,
		`{"id":"a","kind":"finished","workspace":"w1","card":3,"text":"[job finished] x — done"}`,
		`{"id":"b","kind":"note","workspace":"w2","text":"[job note] y — hi"}`,
		`{"id":"c","kind":"note","text":"no workspace"}`,
		`{"id":"d","kind":"note","workspace":"w1"}`,
		`{"id":"e","kind":"note","workspace":"w1","text":"cut sho`,
		`{"ack":["a"],"at":"2026-10-23T10:00:00.000Z"}`,
	)
	in, err := ReadInbox(dir)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, m := range in.Messages {
		ids = append(ids, m.ID)
	}
	if got := strings.Join(ids, ","); got != "a,b,c" {
		t.Fatalf("messages %s", got)
	}
	if !in.Acked["a"] || in.Acked["b"] {
		t.Fatalf("acked %v", in.Acked)
	}
	var w1 []string
	for _, m := range in.Unacked("w1") {
		w1 = append(w1, m.ID)
	}
	if got := strings.Join(w1, ","); got != "c" {
		t.Fatalf("w1 unacked %s", got)
	}
	if len(in.Unacked("")) != 2 {
		t.Fatalf("no workspace: every unacked one")
	}
	if in.Messages[0].CardID() != "3" || in.Messages[1].CardID() != "" {
		t.Fatalf("card ids")
	}
	if empty, err := ReadInbox(t.TempDir()); err != nil || len(empty.Messages) != 0 {
		t.Fatalf("a missing inbox is empty")
	}
}

func TestAckWritesOneLineAndSaysWhatItDid(t *testing.T) {
	dir := t.TempDir()
	writeLines(t, dir,
		`{"id":"a","kind":"note","workspace":"w1","text":"1"}`,
		`{"id":"b","kind":"note","workspace":"w1","text":"2"}`,
		`{"ack":["b"],"at":"2026-10-23T10:00:00.000Z"}`,
	)
	now := time.Date(2026, 10, 23, 11, 0, 0, 0, time.UTC)
	res, err := Ack(dir, []string{"#a", "b", "zz", "a"}, false, "w1", "w1:p1", now)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(res.Acked, res.Already, res.Unknown) != "[a] [b] [zz]" {
		t.Fatalf("result %+v", res)
	}
	data, _ := os.ReadFile(filepath.Join(dir, inboxFile))
	last := strings.Split(strings.TrimSpace(string(data)), "\n")
	if got := last[len(last)-1]; got != `{"ack":["a"],"at":"2026-10-23T11:00:00.000Z","by":"w1:p1"}` {
		t.Fatalf("ack line %s", got)
	}
	// Nothing new to ack: no line.
	if _, err := Ack(dir, []string{"a"}, false, "w1", "", now); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(filepath.Join(dir, inboxFile))
	if !bytes.Equal(again, data) {
		t.Fatalf("a repeat ack wrote")
	}
	if _, err := os.Stat(filepath.Join(dir, inboxFile+".lock")); !os.IsNotExist(err) {
		t.Fatalf("lock left behind")
	}
}

func TestLockIsBoardMjsLock(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, inboxFile)
	lock := file + ".lock"
	// A lock whose owner is gone (a dead pid on this host) is reaped.
	if err := os.Mkdir(lock, 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(lock, "owner"), []byte(fmt.Sprintf("%d %s deadbeef", 1<<30, hostname())), 0o600)
	ran := false
	if err := WithLock(file, func() error { ran = true; return nil }); err != nil || !ran {
		t.Fatalf("stale lock not reaped: %v", err)
	}
	// A live owner (this process) holds it: a second taker waits, then gets it.
	if err := os.Mkdir(lock, 0o700); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(lock, "owner"), []byte(fmt.Sprintf("%d %s cafe", os.Getpid(), hostname())), 0o600)
	var wg sync.WaitGroup
	wg.Add(1)
	start := time.Now()
	var waited time.Duration
	go func() {
		defer wg.Done()
		_ = WithLock(file, func() error { waited = time.Since(start); return nil })
	}()
	time.Sleep(300 * time.Millisecond)
	_ = os.RemoveAll(lock)
	wg.Wait()
	if waited < 250*time.Millisecond {
		t.Fatalf("took a held lock after %v", waited)
	}
}

func TestForPaneAndLiveNotes(t *testing.T) {
	dir := t.TempDir()
	now := time.Now()
	if _, err := WriteNote(dir, Note{PID: os.Getpid(), Host: hostname(), At: now.UTC().Format(time.RFC3339Nano), Pane: "w1:p2", Workspace: "w1"}); err != nil {
		t.Fatal(err)
	}
	_, _ = WriteNote(dir, Note{PID: 1 << 30, Host: hostname(), At: now.UTC().Format(time.RFC3339Nano), Pane: "w1:p3"})
	live := LivePanes(dir, now)
	if !live["w1:p2"] || live["w1:p3"] || len(live) != 1 {
		t.Fatalf("live %v", live)
	}
	if len(LivePanes(dir, now.Add(noteFresh+time.Second))) != 0 {
		t.Fatalf("an old note isn't live")
	}
	answer := Message{ID: "x", To: "w1:p2"}
	if ForPane(answer, "w1:p1", live) || !ForPane(answer, "w1:p2", live) {
		t.Fatalf("an answer for a live pane goes there only")
	}
	if !ForPane(Message{ID: "y", To: "w1:p3"}, "w1:p1", live) {
		t.Fatalf("an answer for a gone pane goes anywhere in the workspace")
	}
	if !ForPane(Message{ID: "z"}, "w1:p1", live) {
		t.Fatalf("a job's message goes to every pane")
	}
}

func TestPathsMatchBoardMjs(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	if d, _ := StoreDir(env(map[string]string{"HOME": "/h"})); d != "/h/.local/state/herdr-job-board" {
		t.Fatal(d)
	}
	if d, _ := StoreDir(env(map[string]string{"HOME": "/h", "XDG_STATE_HOME": "/x"})); d != "/x/herdr-job-board" {
		t.Fatal(d)
	}
	if d, _ := StoreDir(env(map[string]string{"HOME": "/h", "XDG_STATE_HOME": "rel"})); d != "/h/.local/state/herdr-job-board" {
		t.Fatal(d)
	}
	if d, _ := StoreDir(env(map[string]string{"JOB_BOARD_HOME": "/j"})); d != "/j" {
		t.Fatal(d)
	}
	if _, err := StoreDir(env(map[string]string{"HOME": ""})); err == nil {
		t.Fatal("an empty HOME is refused")
	}
	if d, _ := BoardDir(env(map[string]string{"JOB_BOARD_FILE": "/b/my.json"})); d != "/b/my.d" {
		t.Fatal(d)
	}
	if d, _ := BoardDir(env(map[string]string{"JOB_BOARD_FILE": "/b/board.json"})); d != "/b" {
		t.Fatal(d)
	}
}

func TestWriteRefusal(t *testing.T) {
	home := accountHome()
	live := filepath.Join(home, ".local", "state", pluginID)
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	plain := env(map[string]string{"HOME": home})
	if WriteRefusal(live, "/opt/dev/job-board-channel", plain) == "" {
		t.Fatal("a development build writes the live board")
	}
	if WriteRefusal(live, filepath.Join(home, ".config", "herdr", "plugins", "github-installations", "x", "1", "checkout", "channel", "bin", "job-board-channel"), plain) != "" {
		t.Fatal("the installed copy may write")
	}
	if WriteRefusal(live, filepath.Join(home, ".claude", "plugins", "cache", "m", "job-board", "0.9.0", "bin", "job-board-channel"), plain) != "" {
		t.Fatal("a copy in Claude's plugin cache may write")
	}
	scratch := t.TempDir()
	if !strings.HasPrefix(scratch, home) && WriteRefusal(scratch, "/opt/dev/x", plain) != "" {
		t.Fatal("outside the home any copy writes")
	}
	mine := filepath.Join(home, "scratch-board")
	if WriteRefusal(mine, "/opt/dev/x", env(map[string]string{"HOME": home, "JOB_BOARD_DEV": "1", "JOB_BOARD_HOME": mine})) != "" {
		t.Fatal("JOB_BOARD_DEV=1 with a board of its own")
	}
	if WriteRefusal(live, "/opt/dev/x", env(map[string]string{"HOME": home, "JOB_BOARD_DEV": "1", "JOB_BOARD_HOME": live})) == "" {
		t.Fatal("JOB_BOARD_DEV=1 never opens the machine's one board")
	}
	if WriteRefusal(scratch, "/opt/dev/x", env(map[string]string{"JOB_BOARD_TEST_SANDBOX": "/nowhere"})) == "" {
		t.Fatal("the test sandbox")
	}
}

// rpc runs the server on `in` (JSON-RPC lines) and returns what it wrote.
type rpcOut struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (o *rpcOut) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.buf.Write(p)
}

func (o *rpcOut) lines(t *testing.T) []map[string]any {
	o.mu.Lock()
	defer o.mu.Unlock()
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(o.buf.String()), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("bad line %q", l)
		}
		out = append(out, m)
	}
	return out
}

func TestServerProtocolAndPushes(t *testing.T) {
	dir := t.TempDir()
	writeLines(t, dir,
		`{"id":"a","kind":"finished","slug":"fix","workspace":"w1","card":4,"project":"p","at":"2026-10-23T10:00:00.000Z","text":"[job finished] fix — done — ok"}`,
		`{"id":"b","kind":"note","workspace":"w2","text":"other workspace"}`,
	)
	out := &rpcOut{}
	now := time.Now()
	s := &server{out: out, dir: dir, workspace: "w1", pane: "w1:p1", now: func() time.Time { return now }, delivered: map[string]*push{}}
	req := func(line string) {
		var r request
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			t.Fatal(err)
		}
		s.handle(r)
	}
	req(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28"}}`)
	req(`{"jsonrpc":"2.0","id":2,"method":"server/discover"}`)
	req(`{"jsonrpc":"2.0","method":"notifications/unknown"}`)
	lines := out.lines(t)
	if len(lines) != 2 {
		t.Fatalf("replies %v", lines)
	}
	if v := lines[0]["result"].(map[string]any)["protocolVersion"]; v != revisions[0] {
		t.Fatalf("a revision it doesn't know gets %s, got %v", revisions[0], v)
	}
	if lines[1]["error"].(map[string]any)["code"].(float64) != -32601 {
		t.Fatalf("discovery must be method-not-found")
	}
	// No push before initialized; then one per message, once.
	s.look()
	if len(out.lines(t)) != 2 {
		t.Fatal("pushed before initialized")
	}
	s.ready = true
	s.look()
	s.look()
	lines = out.lines(t)
	if len(lines) != 3 {
		t.Fatalf("pushes %v", lines[2:])
	}
	ev := lines[2]
	if ev["method"] != "notifications/claude/channel" {
		t.Fatal(ev)
	}
	params := ev["params"].(map[string]any)
	meta := params["meta"].(map[string]any)
	if params["content"] != "[job finished] fix — done — ok" || meta["id"] != "a" || meta["card"] != "4" || meta["slug"] != "fix" || meta["kind"] != "finished" {
		t.Fatalf("event %v", params)
	}
	// Still unacked after `again`: pushed again, marked so, at most `repeats` more times.
	for i := 0; i < repeats+2; i++ {
		now = now.Add(again + time.Second)
		s.look()
	}
	lines = out.lines(t)
	if len(lines) != 3+repeats {
		t.Fatalf("repeats: %d lines", len(lines))
	}
	if lines[3]["params"].(map[string]any)["meta"].(map[string]any)["again"] == nil {
		t.Fatal("a repeat says so")
	}
	// The tools.
	req(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ack","arguments":{"all":true}}}`)
	req(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"inbox","arguments":{}}}`)
	req(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ack","arguments":{}}}`)
	lines = out.lines(t)
	text := func(l map[string]any) string {
		return l["result"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"].(string)
	}
	n := len(lines)
	if text(lines[n-3]) != "acked #a" || text(lines[n-2]) != "(no unacked messages)" || lines[n-1]["result"].(map[string]any)["isError"] != true {
		t.Fatalf("tools: %q %q", text(lines[n-3]), text(lines[n-2]))
	}
	// A refusing guard: nothing acked, said so.
	writeLines(t, dir, `{"id":"c","kind":"note","workspace":"w1","text":"x"}`)
	s.refusal = "not the installed plugin"
	req(`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ack","arguments":{"ids":["c"]}}}`)
	lines = out.lines(t)
	if !strings.HasPrefix(text(lines[len(lines)-1]), "nothing acked: not the installed plugin") {
		t.Fatal("the guard")
	}
}
