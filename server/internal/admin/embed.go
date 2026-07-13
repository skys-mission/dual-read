package admin

import "embed"

//go:embed static/*
var distFS embed.FS
