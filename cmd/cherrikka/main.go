package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

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
	input := fs.String("input", "", "input backup zip")
	output := fs.String("output", "", "output backup zip")
	from := fs.String("from", "auto", "source format: auto|cherry|rikka")
	to := fs.String("to", "", "target format: cherry|rikka")
	template := fs.String("template", "", "target template backup zip")
	redact := fs.Bool("redact-secrets", false, "redact secret fields")
	_ = fs.Parse(args)

	if *input == "" || *output == "" || *to == "" {
		die("--input, --output, --to are required")
	}

	manifest, err := app.Convert(app.ConvertOptions{
		InputPath:     *input,
		OutputPath:    *output,
		From:          *from,
		To:            *to,
		TemplatePath:  *template,
		RedactSecrets: *redact,
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
  cherrikka convert --input <src.zip> --output <dst.zip> --from auto|cherry|rikka --to cherry|rikka [--template <target-template.zip>] [--redact-secrets]
  cherrikka serve --listen 127.0.0.1:7788`)
}
