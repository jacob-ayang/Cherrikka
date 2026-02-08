package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"cherrikka/internal/app"
	"cherrikka/internal/web"
)

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "inspect":
		runInspect(os.Args[2:])
	case "validate":
		runValidate(os.Args[2:])
	case "convert":
		runConvert(os.Args[2:])
	case "serve":
		runServe(os.Args[2:])
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		printUsage()
		os.Exit(2)
	}
}

func runInspect(args []string) {
	fs := flag.NewFlagSet("inspect", flag.ExitOnError)
	input := fs.String("input", "", "input backup zip")
	_ = fs.Parse(args)
	if *input == "" {
		die("--input is required")
	}
	res, err := app.Inspect(*input)
	if err != nil {
		die(err.Error())
	}
	printJSON(res)
}

func runValidate(args []string) {
	fs := flag.NewFlagSet("validate", flag.ExitOnError)
	input := fs.String("input", "", "input backup zip")
	_ = fs.Parse(args)
	if *input == "" {
		die("--input is required")
	}
	res, err := app.Validate(*input)
	if err != nil {
		die(err.Error())
	}
	printJSON(res)
}

func runConvert(args []string) {
	fs := flag.NewFlagSet("convert", flag.ExitOnError)
	var inputs multiStringFlag
	fs.Var(&inputs, "input", "input backup zip (repeatable)")
	output := fs.String("output", "", "output backup zip")
	from := fs.String("from", "auto", "source format: auto|cherry|rikka")
	to := fs.String("to", "", "target format: cherry|rikka")
	template := fs.String("template", "", "target template backup zip")
	redact := fs.Bool("redact-secrets", false, "redact secret fields")
	configPrecedence := fs.String("config-precedence", "latest", "config precedence for multi-input merge: latest|first|target|source")
	configSourceIndex := fs.Int("config-source-index", 0, "1-based source index when --config-precedence=source")
	_ = fs.Parse(args)

	if len(inputs) == 0 || *output == "" || *to == "" {
		die("--input, --output, --to are required")
	}

	manifest, err := app.Convert(app.ConvertOptions{
		InputPath:         inputs[0],
		InputPaths:        []string(inputs),
		OutputPath:        *output,
		From:              *from,
		To:                *to,
		TemplatePath:      *template,
		RedactSecrets:     *redact,
		ConfigPrecedence:  *configPrecedence,
		ConfigSourceIndex: *configSourceIndex,
	})
	if err != nil {
		die(err.Error())
	}
	printJSON(map[string]any{
		"ok":       true,
		"output":   *output,
		"manifest": manifest,
	})
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	listen := fs.String("listen", "127.0.0.1:7788", "listen address")
	_ = fs.Parse(args)
	if err := web.Serve(*listen); err != nil {
		die(err.Error())
	}
}

func printJSON(v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	fmt.Println(string(b))
}

func die(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}

func printUsage() {
	fmt.Println(`cherrikka commands:

  cherrikka inspect --input <backup.zip>
  cherrikka validate --input <backup.zip>
  cherrikka convert --input <src.zip> [--input <src2.zip> ...] --output <dst.zip> --from auto|cherry|rikka --to cherry|rikka [--template <target-template.zip>] [--redact-secrets] [--config-precedence latest|first|target|source] [--config-source-index <n>]
  cherrikka serve --listen 127.0.0.1:7788`)
}

type multiStringFlag []string

func (m *multiStringFlag) String() string {
	if m == nil {
		return ""
	}
	return strings.Join(*m, ",")
}

func (m *multiStringFlag) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	*m = append(*m, value)
	return nil
}
