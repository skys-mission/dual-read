package main

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
)

const (
	bgHex = 0x2563eb
	fgHex = 0xffffff
)

func main() {
	outDir := "."
	if len(os.Args) > 1 {
		outDir = os.Args[1]
	}
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, "mkdir:", err)
		os.Exit(1)
	}

	sizes := []int{16, 32, 48, 128}
	for _, size := range sizes {
		img := drawIcon(size)
		path := filepath.Join(outDir, fmt.Sprintf("icon%d.png", size))
		f, err := os.Create(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, "create:", err)
			os.Exit(1)
		}
		if err := png.Encode(f, img); err != nil {
			fmt.Fprintln(os.Stderr, "encode:", err)
			os.Exit(1)
		}
		_ = f.Close()
		fmt.Println("generated", path)
	}
}

func drawIcon(size int) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, size, size))

	bg := color.RGBA{R: 0x25, G: 0x63, B: 0xeb, A: 0xff}
	fg := color.RGBA{R: 0xff, G: 0xff, B: 0xff, A: 0xff}

	// Fill background with rounded corners.
	radius := size / 5
	fillRoundedRect(img, image.Rect(0, 0, size, size), bg, radius)

	// Draw two overlapping white rectangles representing dual (side-by-side) text.
	pad := size / 5
	gap := size / 16
	if gap < 1 {
		gap = 1
	}
	h := size - 2*pad
	w := (size - 2*pad - gap) / 2
	x1 := pad
	x2 := pad + w + gap
	y := pad

	fillRoundedRect(img, image.Rect(x1, y, x1+w, y+h), fg, radius/2)
	fillRoundedRect(img, image.Rect(x2, y, x2+w, y+h), fg, radius/2)

	return img
}

func fillRoundedRect(img *image.RGBA, r image.Rectangle, c color.Color, radius int) {
	// Draw main rectangle minus corners.
	midX := (r.Min.X + r.Max.X) / 2
	midY := (r.Min.Y + r.Max.Y) / 2
	for x := r.Min.X; x < r.Max.X; x++ {
		for y := r.Min.Y; y < r.Max.Y; y++ {
			dx := 0
			if x < r.Min.X+radius {
				dx = r.Min.X + radius - x
			} else if x >= r.Max.X-radius {
				dx = x - (r.Max.X - radius - 1)
			}
			dy := 0
			if y < r.Min.Y+radius {
				dy = r.Min.Y + radius - y
			} else if y >= r.Max.Y-radius {
				dy = y - (r.Max.Y - radius - 1)
			}
			if dx*dx+dy*dy <= radius*radius {
				img.Set(x, y, c)
			} else if x >= r.Min.X+radius && x < r.Max.X-radius {
				img.Set(x, y, c)
			} else if y >= r.Min.Y+radius && y < r.Max.Y-radius {
				img.Set(x, y, c)
			}
		}
	}
	_ = midX
	_ = midY
}
