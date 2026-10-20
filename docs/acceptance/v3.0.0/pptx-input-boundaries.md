# PPTX input-boundary evidence

This is package/parser evidence only; no Office application was launched. The two underlying real MIT course packages are documented separately in [pptx-real-samples.md](pptx-real-samples.md). Their source files were read-only during this probe.

## Existing production checks

`presentation_workflows.rs::source_pptx` checks that the asset filename ends in `.pptx` before calling `inspect_pptx`. A non-`.pptx` asset is rejected with `invalid_presentation: 源素材必须是 PPTX 文件。` This is source-path inspection, not an exercised native command with a canonical `.ppt` asset.

The codec's `read_package` rejects invalid ZIP/PPTX input. `inspect_package` follows each slide's actual layout, master, and theme relationships and groups variants by that tuple. The existing `presentation_import_compile.rs` test creates a second layout on the same master; it does not cover multiple masters, legacy `.ppt`, or damaged input.

## Bounded offline probe

A temporary, valid two-master package was assembled from the MIT 12.010 base package and the CMS.595 master/layout/theme parts. It is a synthetic relationship fixture, not a third real course deck. `unzip -t` passed. The production `presentation_import.rs::inspect_pptx` accepted it and reported 23 slides and three variants:

| Variant | Master | Layout | Slides |
| --- | --- | --- | ---: |
| variant-1 | `ppt/slideMasters/slideMaster1.xml` | `ppt/slideLayouts/slideLayout1.xml` | 1 |
| variant-2 | `ppt/slideMasters/slideMaster2.xml` | `ppt/slideLayouts/slideLayout3.xml` | 1 |
| variant-3 | `ppt/slideMasters/slideMaster1.xml` | `ppt/slideLayouts/slideLayout2.xml` | 21 |

The codec rejected an 81-byte controlled text payload named `.ppt` and rejected a half-length copy of the real MIT 12.010 PPTX. Both parser errors were `invalid Zip archive: Could not find EOCD`. The `.ppt` case tests invalid-package rejection only; it is not a real legacy PowerPoint/OLE file and says nothing about parsing legacy `.ppt` content. The damaged case derives from the 778,721-byte real sample; its original remained unchanged.

The exact command was:

```sh
CARGO_TARGET_DIR=/private/tmp/workbench-real-pptx/input-boundary-target \
  cargo run --offline \
  --manifest-path /private/tmp/workbench-real-pptx/probe/Cargo.toml \
  --bin input_boundaries
```

It exited 0. The temporary probe source SHA-256 is `c14d78194885142eced0927851d8875d8f9afda07f3b3479353c822875ddfe26`; its input receipt SHA-256 is `90b11bbdebc6caf74e3629c63c17e0f1eca345a9a628aa294acffb80e297c735`. The `/private/tmp/workbench-real-pptx/input-boundaries` directory contains four files (three test inputs and the receipt); none are repository assets.

The synthetic dual-master package SHA-256 is `ba88fd1308c37e5e7e67990af2e38a9b999a44b1e38f3170a651152bbad16740`. The controlled `.ppt` text payload SHA-256 is `abe93e8a8c3a45411c9b4cc4515aafcb969952dc22995bc4a4de3c8c29eeff31`. The damaged MIT 12.010 copy SHA-256 is `97c0ae1af132c29c99bf319a4448d2f7ba7f289f21f73e258a0b0cc4da30e9f7`. The unchanged source SHA-256 values are 12.010 `86bb5011af3258ffda346fbf90e4af5d6b2e839546506eb2008954c1aebabecb` and CMS.595 `27f396393ae6fe80883b6c183d37baf24a518d52c54ffaeebb5bc126570210f1`.

This demonstrates structural parsing of a synthetic two-master package and rejection of malformed ZIP/PPTX inputs. It does not demonstrate an actual multi-master course deck, actual legacy `.ppt` parsing, Office rendering/editing, or visual fidelity.
