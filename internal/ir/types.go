package ir

import "time"

type BackupIR struct {
	SourceApp     string            `json:"sourceApp"`
	SourceFormat  string            `json:"sourceFormat"`
	TargetFormat  string            `json:"targetFormat,omitempty"`
	DetectedHints []string          `json:"detectedHints,omitempty"`
	CreatedAt     time.Time         `json:"createdAt"`
	Assistants    []IRAssistant     `json:"assistants,omitempty"`
	Conversations []IRConversation  `json:"conversations,omitempty"`
	Files         []IRFile          `json:"files,omitempty"`
	Config        map[string]any    `json:"config,omitempty"`
	Settings      map[string]any    `json:"settings,omitempty"`
	Opaque        map[string]any    `json:"opaque,omitempty"`
	Secrets       map[string]string `json:"secrets,omitempty"`
	Warnings      []string          `json:"warnings,omitempty"`
}

type IRAssistant struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Prompt      string         `json:"prompt,omitempty"`
	Description string         `json:"description,omitempty"`
	Model       map[string]any `json:"model,omitempty"`
	Settings    map[string]any `json:"settings,omitempty"`
	Opaque      map[string]any `json:"opaque,omitempty"`
}

type IRConversation struct {
	ID          string         `json:"id"`
	AssistantID string         `json:"assistantId,omitempty"`
	Title       string         `json:"title,omitempty"`
	CreatedAt   string         `json:"createdAt,omitempty"`
	UpdatedAt   string         `json:"updatedAt,omitempty"`
	Messages    []IRMessage    `json:"messages"`
	Opaque      map[string]any `json:"opaque,omitempty"`
}

type IRMessage struct {
	ID        string         `json:"id"`
	Role      string         `json:"role"`
	CreatedAt string         `json:"createdAt,omitempty"`
	ModelID   string         `json:"modelId,omitempty"`
	Parts     []IRPart       `json:"parts"`
	Opaque    map[string]any `json:"opaque,omitempty"`
}

type IRPart struct {
	Type       string         `json:"type"` // text|reasoning|tool|image|video|audio|document
	Content    string         `json:"content,omitempty"`
	Name       string         `json:"name,omitempty"` // tool name/document file name
	FileID     string         `json:"fileId,omitempty"`
	MediaURL   string         `json:"mediaUrl,omitempty"`
	MimeType   string         `json:"mimeType,omitempty"`
	Input      string         `json:"input,omitempty"`
	ToolCallID string         `json:"toolCallId,omitempty"`
	Output     []IRPart       `json:"output,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

type IRFile struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	RelativeSrc string         `json:"relativeSrc,omitempty"`
	SourcePath  string         `json:"-"`
	Size        int64          `json:"size,omitempty"`
	MimeType    string         `json:"mimeType,omitempty"`
	Ext         string         `json:"ext,omitempty"`
	CreatedAt   string         `json:"createdAt,omitempty"`
	UpdatedAt   string         `json:"updatedAt,omitempty"`
	HashSHA256  string         `json:"hashSha256,omitempty"`
	LogicalType string         `json:"logicalType,omitempty"`
	Missing     bool           `json:"missing,omitempty"`
	Orphan      bool           `json:"orphan,omitempty"`
	Metadata    map[string]any `json:"metadata,omitempty"`
}

type Manifest struct {
	SchemaVersion int               `json:"schemaVersion"`
	SourceApp     string            `json:"sourceApp"`
	SourceFormat  string            `json:"sourceFormat"`
	SourceSHA256  string            `json:"sourceSha256"`
	TargetApp     string            `json:"targetApp"`
	TargetFormat  string            `json:"targetFormat"`
	IDMap         map[string]string `json:"idMap,omitempty"`
	Redaction     bool              `json:"redaction"`
	CreatedAt     string            `json:"createdAt"`
	Warnings      []string          `json:"warnings,omitempty"`
}
