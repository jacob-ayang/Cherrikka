package util

import "strings"

var secretFieldTokens = []string{
	"api_key",
	"apikey",
	"token",
	"secret",
	"password",
	"access_key",
	"secretaccesskey",
}

func ShouldRedactKey(k string) bool {
	k = strings.ToLower(strings.TrimSpace(k))
	for _, token := range secretFieldTokens {
		if strings.Contains(k, token) {
			return true
		}
	}
	return false
}

func RedactString(v string) string {
	if v == "" {
		return v
	}
	return "***REDACTED***"
}

func RedactAny(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if ShouldRedactKey(k) {
				s, ok := val.(string)
				if ok {
					out[k] = RedactString(s)
				} else {
					out[k] = "***REDACTED***"
				}
				continue
			}
			out[k] = RedactAny(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = RedactAny(val)
		}
		return out
	default:
		return v
	}
}
