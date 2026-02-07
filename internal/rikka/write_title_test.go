package rikka

import (
	"strings"
	"testing"

	"cherrikka/internal/ir"
)

func TestDeriveRikkaConversationTitle_UsesExistingTitle(t *testing.T) {
	conv := ir.IRConversation{
		Title: "  My Topic  ",
		Messages: []ir.IRMessage{
			{Role: "user", Parts: []ir.IRPart{{Type: "text", Content: "hello"}}},
		},
	}
	got := deriveRikkaConversationTitle(conv)
	if got != "My Topic" {
		t.Fatalf("expected existing title, got=%q", got)
	}
}

func TestDeriveRikkaConversationTitle_FromFirstUserText(t *testing.T) {
	conv := ir.IRConversation{
		Title: "",
		Messages: []ir.IRMessage{
			{Role: "assistant", Parts: []ir.IRPart{{Type: "text", Content: "assistant hello"}}},
			{Role: "user", Parts: []ir.IRPart{{Type: "text", Content: "  用户想问：如何安装ollama  "}}},
		},
	}
	got := deriveRikkaConversationTitle(conv)
	if got != "用户想问：如何安装ollama" {
		t.Fatalf("expected derived user title, got=%q", got)
	}
}

func TestDeriveRikkaConversationTitle_FallbackImported(t *testing.T) {
	conv := ir.IRConversation{
		Title:    "",
		Messages: []ir.IRMessage{{Role: "assistant", Parts: []ir.IRPart{{Type: "tool", Name: ""}}}},
	}
	got := deriveRikkaConversationTitle(conv)
	if got != "Imported Conversation" {
		t.Fatalf("expected fallback title, got=%q", got)
	}
}

func TestNormalizeConversationTitleText_TruncatesLongText(t *testing.T) {
	long := strings.Repeat("a", 120)
	got := normalizeConversationTitleText(long)
	if !strings.HasSuffix(got, "…") {
		t.Fatalf("expected ellipsis suffix, got=%q", got)
	}
	if len([]rune(got)) > 81 {
		t.Fatalf("expected truncated title length <= 81 runes, got=%d", len([]rune(got)))
	}
}
