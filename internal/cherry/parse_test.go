package cherry

import (
	"testing"

	"cherrikka/internal/ir"
)

func TestBuildAssistantsSlice_DefaultAssistantDoesNotMutateAssistants(t *testing.T) {
	slice := buildAssistantsSlice([]ir.IRAssistant{
		{ID: "0950e2dc-9bd5-4801-afa3-aa887aa36b4e", Name: "Rikka Default"},
	}, map[string][]ir.IRConversation{
		"0950e2dc-9bd5-4801-afa3-aa887aa36b4e": {
			{
				ID:         "topic-1",
				AssistantID: "0950e2dc-9bd5-4801-afa3-aa887aa36b4e",
				Title:      "T1",
			},
		},
	})

	defaultAssistant, _ := slice["defaultAssistant"].(map[string]any)
	assistants, _ := slice["assistants"].([]any)
	if len(assistants) == 0 {
		t.Fatalf("assistants should not be empty")
	}
	first, _ := assistants[0].(map[string]any)
	if defaultAssistant["id"] != "default" {
		t.Fatalf("defaultAssistant id = %v, want default", defaultAssistant["id"])
	}
	if first["id"] == "default" {
		t.Fatalf("assistants[0].id should keep original id, got default")
	}
}
