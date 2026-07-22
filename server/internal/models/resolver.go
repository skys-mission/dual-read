package models

import (
	"strings"

	"github.com/skys-mission/dual-read/server/internal/auth"
	"github.com/skys-mission/dual-read/server/internal/config"
)

// Resolver maps client-facing model names to upstream model ids.
type Resolver struct {
	defaultModel string
	global       map[string]string
}

// NewResolver builds a model resolver from config.
func NewResolver(cfg config.ModelsConfig) *Resolver {
	m := make(map[string]string, len(cfg.Map))
	for k, v := range cfg.Map {
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if k == "" || v == "" {
			continue
		}
		m[k] = v
	}
	def := strings.TrimSpace(cfg.Default)
	return &Resolver{defaultModel: def, global: m}
}

// Resolve returns the upstream model id and the client-facing name used.
func (r *Resolver) Resolve(requested string, id *auth.Identity) (upstreamModel, clientModel string) {
	requested = strings.TrimSpace(requested)

	if requested == "" {
		if id != nil && id.DefaultModel != "" {
			requested = id.DefaultModel
		} else if r != nil && r.defaultModel != "" {
			requested = r.defaultModel
		}
	}
	clientModel = requested
	if requested == "" {
		return "", ""
	}

	if id != nil && len(id.Models) > 0 {
		if mapped, ok := id.Models[requested]; ok && mapped != "" {
			return mapped, clientModel
		}
	}
	if r != nil {
		if mapped, ok := r.global[requested]; ok && mapped != "" {
			return mapped, clientModel
		}
		if r.defaultModel != "" && requested == "" {
			return r.defaultModel, r.defaultModel
		}
	}
	return requested, clientModel
}

// Default returns the configured default model.
func (r *Resolver) Default() string {
	if r == nil {
		return ""
	}
	return r.defaultModel
}

// GlobalMap returns a copy of global mappings for admin.
func (r *Resolver) GlobalMap() map[string]string {
	if r == nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(r.global))
	for k, v := range r.global {
		out[k] = v
	}
	return out
}
