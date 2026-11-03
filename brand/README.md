# brand — longbrowse logo and LB frame

- `lb-logo-glossy.png` — the glossy LB hexagon mark (source)
- `lb-frame-source.png` — the LB ribbon frame (source, with stray specks)
- `frame/lb-frame-clean.png` — the frame with the specks removed and cropped
- `frame/left.png` · `frame/middle.png` · `frame/right.png` — the frame cut in three for any text length:
  left = cap + LB, right = cap, middle = straight band, stretched to the text (`background-size: 100% 100%`)
- `frame/demo.html` — the CSS (`.lbframe`, one `--h` variable sets the size) with short and long words
- `frame/web/*.png` — the three pieces at 128 px tall, for pages
- `lbframe.css` — drop-in class using the web pieces, ribbon colour variables (`--lb-cyan` … `--lb-grad`) and gradient text (`.grad`); served by longbrowse at `/brand/lbframe.css`
- `lb-logo-glossy-256.png` — the mark, small
- `lb-ui.css` — the "Ribbon Geometric" UI style: tokens, buttons, inputs, checkbox, switch, cards, section
  headings, status rows, nav, badges, progress; served at `/brand/lb-ui.css`. `lb-ui.html` shows every component.
- `lb-letters.png` — the LB letters alone (transparent), cut from the frame
- `lb-icon-512.png` — app/extension icon: LB on a dark tile with the ribbon-gradient border
- `longbrowse-banner.png` — the LB frame with "longbrowse", transparent background (README header)
