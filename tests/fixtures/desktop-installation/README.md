These are credential-free native screenshots from the pinned Linux client at
1280×720. `addons.png` and `manifest.png` come from the original fixture trial;
`add-url.png` and `not-installed.png` reproduce the later softpipe installation
race. `hosted-manifest.png` is the configurable hosted adapter's dialog with its
Configure and Install buttons; its private add-on URL band is blacked out
exactly as the hosted trial retains it. `hosted-long-url-manifest.png` is the
same dialog with a wrapped add-on URL of issued-credential length; the dialog
grows and its Install button moves down, and the whole URL block is blacked out.
The fixture manifest URL points only to a disposable loopback fixture server.

The empty URL dialog previously counted as successful installation because
mouse commands succeeded and a screenshot existed. Retain these pixels to
check active controls against real overlays and text, including rejection of
the no-addons screen. They are UI-state evidence, not decoded playback proof.
