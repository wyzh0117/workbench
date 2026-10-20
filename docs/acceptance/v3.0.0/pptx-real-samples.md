# PPTX validation on public course samples

## Scope

This is package and codec evidence from two real, editable MIT OpenCourseWare course decks. The source files were downloaded to /private/tmp/workbench-real-pptx, made read-only, and never written by the probe. The generated review copies are also only in that temporary directory; no course deck or derived slide was added to the repository.

MIT OCW terms identify course content as CC BY-NC-SA 4.0. The samples and their direct downloads are linked below for provenance; this report republishes no course content.

| Sample | Source and provenance | SHA-256 | Source structure |
| --- | --- | --- | --- |
| MIT 12.010, Computational Methods of Scientific Programming, Lecture 03 | [Official resource page](https://ocw.mit.edu/courses/12-010-computational-methods-of-scientific-programming-fall-2024/resources/mit12_010_f24_lec03_pptx/), [PPTX](https://ocw.mit.edu/courses/12-010-computational-methods-of-scientific-programming-fall-2024/mit12_010_f24_lec03.pptx) | 86bb5011af3258ffda346fbf90e4af5d6b2e839546506eb2008954c1aebabecb | 778,721 bytes; 23 slides; 1 master; 11 layout parts, 2 layouts used by slides; 2 theme parts |
| MIT CMS.595, Learning, Media, and Technology, Session 14 | [Official resource page](https://ocw.mit.edu/courses/cms-595-learning-media-and-technology-spring-2024/resources/mitcms_595_s24_ses14_pptx/), [PPTX](https://ocw.mit.edu/courses/cms-595-learning-media-and-technology-spring-2024/mitcms_595_s24_ses14.pptx) | 27f396393ae6fe80883b6c183d37baf24a518d52c54ffaeebb5bc126570210f1 | 520,072 bytes; 8 slides; 1 master; 11 layout parts, 2 layouts used by slides; 2 theme parts |

The MIT [terms of use](https://ocw.mit.edu/pages/privacy-and-terms-of-use/) state CC BY-NC-SA 4.0 for OCW content. Both source ZIP packages passed unzip -t before parsing. A third larger MIT sample was downloaded before narrowing the run to these two and then removed unused.

## Parser observations

The parser read both package relationships and returned two variants per source, each attached to the same master and to a distinct layout part. For 12.010, variant-1 uses slideLayout1 for slide1 and variant-2 uses slideLayout2 for slides2–23. For CMS.595, variant-1 uses slideLayout1 for slides1–2 and variant-2 uses slideLayout2 for slides3–8.

The package XML contains these named fonts in text runs and theme declarations:

- 12.010: Calibri, Calibri Light, and Times New Roman; sampled explicit sizes span 10–60 pt.
- CMS.595: Arial, Calibri, Calibri Light, Circular Std Bold, Palatino, Proxima Nova Rg, and Times New Roman; sampled explicit sizes span 10–60 pt.

The parser’s theme-font facts for each variant include Calibri Light and Calibri plus empty typeface entries for script mappings. These are theme facts, not a complete inventory of every run font in the deck.

Both parser reports retain structural limitations: visual spacing and page-family judgments still need rendered review, complex objects remain in copied source parts, and external relationship targets are not fetched. The source bytes and original slide relationships were compared against append/style outputs; all original slide XML and per-slide relationship parts were byte-identical.

## Codec exercise

The temporary standalone probe imported the production presentation_import.rs module directly. It used each extracted variant’s current structural facts to construct style tokens, then exercised the production copy APIs. Each generated file remained under /private/tmp/workbench-real-pptx/outputs.

| Sample and template | Append sequence | Insert after first slide | Single export | Style and notes |
| --- | --- | --- | --- | --- |
| 12.010; ppt/slides/slide1.xml using slideLayout1 | 23 → 24 → 25 slides | Existing slide ID 257 retained at order 1; new slide24.xml at order 2; original second slide ID followed at order 3 | Parser reported one slide; no other slide XML part remained in the ZIP | New slide XML contained 42 pt title size, color 4E3B73, and requested geometry x=0, y=0, width=80% and height=20% of the canvas; the source template lacked those exact markers. A new notes part contained the requested temporary note. |
| CMS.595; ppt/slides/slide3.xml using slideLayout2 | 8 → 9 → 10 slides | Existing slide ID 303 retained at order 1; new slide9.xml at order 2; original second slide ID followed at order 3 | Parser reported one slide; no other slide XML part remained in the ZIP | The same size, color, and geometry values were written into the new slide; a new notes part contained the requested temporary note. |

For both samples, append and style outputs preserved each original slide XML part and its .rels part byte for byte. The single check covered the presentation slide list and absence of old slide XML parts; it is not an Office-level or whole-metadata visual check. All ten generated packages passed unzip -t. Package validity and parser output do not establish PowerPoint compatibility or visual fidelity.

The CMS.595 cover variant was explicitly skipped for body replacement because it has no supported body text box. The content variant was selected and passed. This is an observed template capability boundary, not a parser error. Both selected representative slides had no picture shape, so these real-sample runs did not exercise image replacement. The existing repository fixture test remains the image-path check.

## Reproduction and limits

The probe source, downloaded files, and output packages are temporary and are not repository artifacts. It compiled offline and exited 0 with this command:

    CARGO_TARGET_DIR=/private/tmp/workbench-real-pptx/probe-target cargo run --offline --manifest-path /private/tmp/workbench-real-pptx/probe/Cargo.toml

The standalone probe source SHA-256 is c5b5619c497f2c5c9994e8f66cdd795acac162423a2acd25aa539f509ac7acd5. Its temporary receipt is /private/tmp/workbench-real-pptx/receipt.txt, SHA-256 e327bc998a5f87ea680ae0eea2730f443d0022ac412e80f7314eec630293058c; the receipt lists all ten output filenames and hashes. The original samples remained mode 0444 with no write bits, and their end hashes matched the recorded source hashes: 12.010 86bb5011af3258ffda346fbf90e4af5d6b2e839546506eb2008954c1aebabecb; CMS.595 27f396393ae6fe80883b6c183d37baf24a518d52c54ffaeebb5bc126570210f1. The output directory contains exactly ten PPTX files.

PowerPoint or LibreOffice was not launched. No Office open/edit/save/render pass is claimed. Each sample has a single master, so multi-master behavior remains unverified. These runs validate the production Rust package codec on two real course packages, not the full native save workflow.
