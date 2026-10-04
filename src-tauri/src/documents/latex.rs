//! `.tex` / `.latex`：只做词法级识别，绝不执行 TeX、绝不访问磁盘、绝不调用外部程序。
//!
//! 原则：
//! - 能可靠识别的结构（章节 / 列表 / 引用 / 逐字代码 / 表格）映射到对应区块；
//! - 数学公式降级保存为代码内容（`degraded = true` + 中文提示），公式源码不丢；
//! - 未知命令 / 未知环境按可读原文保留，并聚合成提示（不得静默丢失）。

use super::{
    markdown_code_span, markdown_escape, plaintext::decode_to_text, BlockSpec, Collector, Kind,
    MAX_EXTRACTED_CHARS,
};
use std::collections::BTreeSet;

/// 章节命令 -> Workbench 标题层级；长名优先匹配，避免 `\section` 抢走 `\subsection`。
const SECTIONING: [(&str, u64); 7] = [
    ("subsubsection", 4),
    ("subsection", 3),
    ("section", 2),
    ("chapter", 1),
    ("part", 1),
    ("paragraph", 5),
    ("subparagraph", 6),
];

const BULLET_ENVS: [&str; 4] = ["itemize", "itemize*", "compactitem", "unnumbereditemize"];
const NUMBERED_ENVS: [&str; 4] = ["enumerate", "enumerate*", "compactenum", "inlineenumerate"];
const DESCRIPTION_ENVS: [&str; 2] = ["description", "description*"];
const LIST_ENVS_MAX_DEPTH: usize = 8;
const QUOTE_ENVS: [&str; 5] = [
    "quote",
    "quotation",
    "blockquote",
    "displayquote",
    "quoting",
];
/// 逐字环境：内部不做宏展开。
const VERBATIM_ENVS: [&str; 7] = [
    "verbatim",
    "verbatim*",
    "lstlisting",
    "minted",
    "listings",
    "alltt",
    "minted*",
];
/// 展示型数学环境：整段降级为代码。
const MATH_ENVS: [&str; 22] = [
    "equation",
    "equation*",
    "eqnarray",
    "eqnarray*",
    "align",
    "align*",
    "alignat",
    "alignat*",
    "gather",
    "gather*",
    "multline",
    "multline*",
    "flalign",
    "flalign*",
    "displaymath",
    "math",
    "split",
    "cases",
    "bmatrix",
    "pmatrix",
    "vmatrix",
    "dmath",
];
const TABULAR_ENVS: [&str; 6] = [
    "tabular",
    "tabular*",
    "tabularx",
    "longtable",
    "array",
    "tabu",
];
/// 只是容器：内容按正文顺序展开。
const TRANSPARENT_ENVS: [&str; 10] = [
    "document",
    "abstract",
    "center",
    "centering",
    "flushleft",
    "flushright",
    "raggedright",
    "figure",
    "table",
    "sidewaystable",
];
/// 无法转成文字的绘图 / 算法环境：保留源码文本。
const GRAPHICS_ENVS: [&str; 6] = [
    "tikzpicture",
    "pgfscope",
    "algorithm",
    "algorithmic",
    "lstfloat",
    "scope",
];
/// 行内命令 -> markdown 强调包裹。
const EMPHASIS: [(&str, &str, &str); 8] = [
    ("textbf", "**", "**"),
    ("bf", "**", "**"),
    ("textit", "*", "*"),
    ("emph", "*", "*"),
    ("it", "*", "*"),
    ("em", "*", "*"),
    ("sout", "~~", "~~"),
    ("st", "~~", "~~"),
];
/// 没有 markdown 对应、只能摊平成纯文本的命令。
const FLATTENED: [&str; 9] = [
    "uline",
    "underline",
    "textsc",
    "textsf",
    "textup",
    "textsuperscript",
    "textsubscript",
    "textcolor",
    "colorbox",
];
/// 符号命令 -> Unicode。
const SYMBOLS: [(&str, &str); 16] = [
    ("ldots", "…"),
    ("dots", "…"),
    ("LaTeX", "LaTeX"),
    ("TeX", "TeX"),
    ("textbullet", "•"),
    ("textbackslash", "\\"),
    ("textasciitilde", "~"),
    ("textasciicircum", "^"),
    ("textdegree", "°"),
    ("copyright", "©"),
    ("pounds", "£"),
    ("euro", "€"),
    ("S", "§"),
    ("textendash", "–"),
    ("textemdash", "—"),
    ("textbar", "|"),
];
/// 纯间距命令 -> 一个空格。
const SPACING: [&str; 8] = ["quad", "qquad", "hspace", "hfill", ",", ";", ":", "!"];
/// 转义字符：`\%` `_` `#` 等按字面保留。
const LITERAL_ESCAPES: [&str; 17] = [
    "%", "$", "&", "_", "#", "{", "}", " ", "\\", "~", "^", "'", "`", "|", "[", "]", "-",
];
/// 声明 / 元信息命令：不产出正文，但要如实告知。
const NON_CONTENT_COMMANDS: [&str; 20] = [
    "documentclass",
    "usepackage",
    "RequirePackage",
    "newcommand",
    "renewcommand",
    "providecommand",
    "DeclareRobustCommand",
    "def",
    "let",
    "setlength",
    "setcounter",
    "addtocounter",
    "linespread",
    "pagestyle",
    "thispagestyle",
    "pagenumbering",
    "title",
    "author",
    "date",
    "thanks",
];
/// 明确忽略的排版 / 结构命令（含分页）。
const IGNORED_COMMANDS: [&str; 26] = [
    "label",
    "index",
    "phantom",
    "hphantom",
    "vphantom",
    "noindent",
    "medskip",
    "smallskip",
    "bigskip",
    "centering",
    "raggedright",
    "normalsize",
    "footnotesize",
    "scriptsize",
    "huge",
    "large",
    "clearpage",
    "newpage",
    "pagebreak",
    "linebreak",
    "maketitle",
    "tableofcontents",
    "listoffigures",
    "listoftables",
    "printbibliography",
    "markboth",
];
const CROSS_REFERENCE_COMMANDS: [&str; 8] = [
    "ref",
    "eqref",
    "autoref",
    "pageref",
    "cite",
    "citep",
    "citet",
    "parencite",
];
const INCLUDE_COMMANDS: [&str; 5] = ["input", "include", "import", "subfile", "subfileinclude"];
const GRAPHICS_COMMANDS: [&str; 4] = ["includegraphics", "epsfig", "psfig", "graphicspath"];

/// 解析中间产物：块种类 + markdown 内容（顶层再落到 Collector）。
struct Item {
    kind: Kind,
    content: String,
    level: Option<u64>,
    language: Option<String>,
}

/// 一次 LaTeX 解析的聚合状态：未知命令与环境名最后汇总成一条提示。
struct Parser<'a> {
    out: &'a mut Collector,
    unknown_macros: BTreeSet<String>,
    unknown_envs: BTreeSet<String>,
    dropped_commands: usize,
    page_breaks: usize,
    cross_references: usize,
    footnotes: usize,
    merged_cells: usize,
    truncated: bool,
}

pub(crate) fn parse_latex(bytes: &[u8], out: &mut Collector) -> Result<(), String> {
    let text = decode_to_text(bytes, out)?;
    let (text, comments) = strip_comments(&text);
    if comments > 0 {
        out.warn(format!("LaTeX 注释（% 到行尾）已忽略，共 {comments} 处。"));
    }
    let mut parser = Parser {
        out,
        unknown_macros: BTreeSet::new(),
        unknown_envs: BTreeSet::new(),
        dropped_commands: 0,
        page_breaks: 0,
        cross_references: 0,
        footnotes: 0,
        merged_cells: 0,
        truncated: false,
    };
    let items = parser.scan(&text, 0);
    parser.flush_items(&items);
    let Parser {
        out,
        unknown_macros,
        unknown_envs,
        dropped_commands,
        page_breaks,
        cross_references,
        footnotes,
        merged_cells,
        truncated,
    } = parser;
    if !unknown_macros.is_empty() {
        let names = unknown_macros
            .iter()
            .take(12)
            .map(|name| format!("\\{name}"))
            .collect::<Vec<_>>()
            .join("、");
        out.degrade(format!("无法识别的 LaTeX 命令已按原文保留：{names}。"));
    }
    if !unknown_envs.is_empty() {
        let names = unknown_envs
            .iter()
            .take(12)
            .map(|name| format!("{{{name}}}"))
            .collect::<Vec<_>>()
            .join("、");
        out.degrade(format!(
            "未支持的环境按正文顺序展开，位置与编号未保留：{names}。"
        ));
    }
    if dropped_commands > 0 {
        out.warn(format!(
            "导言区与元信息命令（\\documentclass、\\title 等）不进入正文，共 {dropped_commands} 处。"
        ));
    }
    if page_breaks > 0 {
        out.warn(format!("分页命令不进入正文，共 {page_breaks} 处。"));
    }
    if cross_references > 0 {
        out.degrade(format!(
            "交叉引用（\\ref、\\cite 等）无法在导入时解析，已按原文保留，共 {cross_references} 处。"
        ));
    }
    if footnotes > 0 {
        out.degrade(format!("脚注已内联到正文，共 {footnotes} 处。"));
    }
    if merged_cells > 0 {
        out.degrade(format!(
            "表格中的合并单元格（\\multicolumn）已展平，共 {merged_cells} 处。"
        ));
    }
    if truncated {
        out.degrade(format!(
            "LaTeX 正文超过 {MAX_EXTRACTED_CHARS} 字符，后续内容未导入，原文件已保留。"
        ));
    }
    Ok(())
}

impl Parser<'_> {
    /// 块级扫描：返回待落地的条目（顶层与嵌套环境共用同一套产物）。
    fn scan(&mut self, source: &str, depth: usize) -> Vec<Item> {
        let chars: Vec<char> = source.chars().collect();
        let mut cursor = Cursor::new(&chars);
        let mut items: Vec<Item> = Vec::new();
        let mut pending = String::new();
        while !cursor.eof() {
            if self.out.text_budget_reached() {
                self.truncated = true;
                break;
            }
            if cursor.starts_with("\\begin{") {
                cursor.pos += "\\begin{".chars().count();
                let env = cursor.read_command_name_like('}');
                cursor.skip_if('}');
                let (body, closed) = cursor.read_env_body(&env);
                if !closed {
                    self.out.warn(format!(
                        "环境 \\begin{{{env}}} 缺少对应的 \\end{{{env}}}，已按读到内容处理。"
                    ));
                }
                self.push_paragraph(&mut pending, &mut items);
                items.extend(self.handle_env(&env, &body, depth));
                continue;
            }
            if cursor.starts_with("\\[") {
                cursor.pos += 2;
                let body = cursor.read_until_str("\\]");
                self.push_paragraph(&mut pending, &mut items);
                items.push(math_item(format!("\\[{body}\\]")));
                self.out
                    .degrade("数学公式已降级保存为代码内容，公式源码未丢失。");
                continue;
            }
            if let Some((command, level)) = sectioning_at(&cursor) {
                cursor.pos += command.chars().count();
                cursor.skip_star();
                // 可选参数是"短标题"，正文用强制参数。
                cursor.read_optional_group();
                let title = cursor.read_group().unwrap_or_default();
                let markdown = self.convert_inline(&title).unwrap_or_default();
                self.push_paragraph(&mut pending, &mut items);
                items.push(Item {
                    kind: Kind::Heading,
                    content: markdown,
                    level: Some(level),
                    language: None,
                });
                continue;
            }
            if cursor.starts_with("\\end{") {
                cursor.pos += "\\end{".chars().count();
                let name = cursor.read_command_name_like('}');
                cursor.skip_if('}');
                self.out
                    .warn(format!("发现多余的 \\end{{{name}}}，已跳过。"));
                continue;
            }
            let character = cursor.bump().unwrap_or('\0');
            match character {
                '\n' => {
                    if cursor.at_blank_line_run() {
                        cursor.skip_whitespace_run();
                        self.push_paragraph(&mut pending, &mut items);
                    } else {
                        pending.push('\n');
                    }
                }
                '$' => {
                    let body = cursor.read_until_char('$');
                    pending.push_str(&markdown_code_span(&format!("${body}$")));
                    self.out
                        .degrade("数学公式已降级保存为代码内容，公式源码未丢失。");
                }
                '{' | '}' => {}
                '\\' => {
                    if let Some(markdown) = self.read_command(&mut cursor) {
                        pending.push_str(&markdown);
                    }
                }
                other => pending.push_str(&markdown_escape(&other.to_string())),
            }
        }
        self.push_paragraph(&mut pending, &mut items);
        items
    }

    fn push_paragraph(&mut self, pending: &mut String, items: &mut Vec<Item>) {
        let content = std::mem::take(pending);
        // LaTeX 里的换行只是源码排版，落进 markdown 正文会变成幽灵空行。
        let content = content.trim_matches(['\n', '\r', ' ', '\t']).to_owned();
        if content.is_empty() {
            return;
        }
        items.push(Item {
            kind: Kind::Paragraph,
            content,
            level: None,
            language: None,
        });
    }

    /// 顶层条目落地。
    fn flush_items(&mut self, items: &[Item]) {
        for item in items {
            self.out.block(BlockSpec {
                kind: item.kind,
                content: item.content.clone(),
                level: item.level,
                language: item.language.clone(),
                checked: None,
                images: Vec::new(),
            });
        }
    }

    fn handle_env(&mut self, env: &str, body: &str, depth: usize) -> Vec<Item> {
        if BULLET_ENVS.contains(&env)
            || NUMBERED_ENVS.contains(&env)
            || DESCRIPTION_ENVS.contains(&env)
        {
            let lines = self.render_list(
                body,
                0,
                NUMBERED_ENVS.contains(&env),
                DESCRIPTION_ENVS.contains(&env),
                depth,
            );
            if lines.is_empty() {
                return Vec::new();
            }
            return vec![Item {
                kind: Kind::List,
                content: lines.join("\n"),
                level: None,
                language: None,
            }];
        }
        if QUOTE_ENVS.contains(&env) {
            let inner = self.scan(body, depth + 1);
            let content = join_items(&inner);
            if content.trim().is_empty() {
                return Vec::new();
            }
            return vec![Item {
                kind: Kind::Quote,
                content,
                level: None,
                language: None,
            }];
        }
        if VERBATIM_ENVS.contains(&env) {
            let (args, content) = split_env_args(body, env);
            let content = content.trim_matches('\n').to_owned();
            if content.trim().is_empty() {
                return Vec::new();
            }
            return vec![Item {
                kind: Kind::Code,
                content,
                level: None,
                language: code_language(env, &args),
            }];
        }
        if MATH_ENVS.contains(&env) {
            self.out
                .degrade("数学公式已降级保存为代码内容，公式源码未丢失。");
            return vec![math_item(format!("\\begin{{{env}}}{body}\\end{{{env}}}"))];
        }
        if TABULAR_ENVS.contains(&env) {
            let (_args, content) = split_env_args(body, env);
            return match self.build_table(&content) {
                Some(markdown) => vec![Item {
                    kind: Kind::Table,
                    content: markdown,
                    level: None,
                    language: None,
                }],
                None => {
                    self.out.warn(format!(
                        "表格环境 {{{env}}} 没有可还原的单元格，原文已按文本保留。"
                    ));
                    vec![Item {
                        kind: Kind::Other,
                        content: markdown_escape(&format!("\\begin{{{env}}}{body}")),
                        level: None,
                        language: None,
                    }]
                }
            };
        }
        if TRANSPARENT_ENVS.contains(&env) {
            if matches!(env, "figure" | "table" | "sidewaystable") {
                self.out.degrade(format!(
                    "浮动环境 {{{env}}} 按正文顺序展开，图/表位置与编号未保留。"
                ));
            }
            if env == "abstract" {
                self.out.warn("摘要环境按正文顺序导入，未单独标注为摘要。");
            }
            return self.scan(body, depth);
        }
        if GRAPHICS_ENVS.contains(&env) {
            self.out.degrade(format!(
                "绘图/算法环境 {{{env}}} 无法转为文字，已按源码文本保留。"
            ));
            return vec![Item {
                kind: Kind::Other,
                content: markdown_escape(&format!("\\begin{{{env}}}{body}\\end{{{env}}}")),
                level: None,
                language: None,
            }];
        }
        if env.starts_with("minipage") {
            return self.scan(body, depth);
        }
        // 未知环境：内容按正文顺序展开（可读原文优先），环境名汇总提示。
        self.unknown_envs.insert(env.to_owned());
        self.scan(body, depth)
    }

    /// 列表：顶层 `\item` 切分 + 嵌套列表环境递归（一层缩进 2 空格）。
    fn render_list(
        &mut self,
        body: &str,
        indent: usize,
        ordered: bool,
        described: bool,
        depth: usize,
    ) -> Vec<String> {
        if depth >= LIST_ENVS_MAX_DEPTH {
            self.out.warn("列表嵌套过深，超出部分已按正文保留。");
            return Vec::new();
        }
        let prefix = " ".repeat(indent.saturating_mul(2));
        let marker = if ordered { "1." } else { "-" };
        let mut lines: Vec<String> = Vec::new();
        let segment: Vec<char> = body.chars().collect();
        let mut cursor = Cursor::new(&segment);
        let mut text = String::new();
        let mut label = String::new();
        let mut has_item = false;
        loop {
            if self.out.text_budget_reached() {
                self.truncated = true;
                break;
            }
            let segment = cursor.take_until_item();
            self.collect_item_text(
                &segment,
                &mut text,
                indent + 1,
                depth,
                &mut lines,
                marker,
                &prefix,
            );
            if cursor.eof() {
                break;
            }
            // 到这里游标停在 `\item` 上：消费它并读取可选标签。
            cursor.pos += "\\item".chars().count();
            let fresh = cursor.read_optional_group().unwrap_or_default();
            if has_item {
                let carried = std::mem::take(&mut text);
                lines.extend(render_line(&prefix, marker, described, &label, &carried));
            } else {
                has_item = true;
                std::mem::take(&mut text);
            }
            if !fresh.trim().is_empty() {
                label = fresh;
            }
        }
        if has_item {
            let carried = std::mem::take(&mut text);
            lines.extend(render_line(&prefix, marker, described, &label, &carried));
        }
        lines
    }

    /// 列表项正文：行内命令转换 + 嵌套列表环境递归。
    fn collect_item_text(
        &mut self,
        segment: &str,
        text: &mut String,
        indent: usize,
        depth: usize,
        lines: &mut Vec<String>,
        marker: &str,
        prefix: &str,
    ) {
        let chars: Vec<char> = segment.chars().collect();
        let mut cursor = Cursor::new(&chars);
        while !cursor.eof() {
            if cursor.starts_with("\\begin{") {
                cursor.pos += "\\begin{".chars().count();
                let env = cursor.read_command_name_like('}');
                cursor.skip_if('}');
                let (body, _) = cursor.read_env_body(&env);
                if BULLET_ENVS.contains(&env.as_str())
                    || NUMBERED_ENVS.contains(&env.as_str())
                    || DESCRIPTION_ENVS.contains(&env.as_str())
                {
                    let nested = self.render_list(
                        &body,
                        indent,
                        NUMBERED_ENVS.contains(&env.as_str()),
                        DESCRIPTION_ENVS.contains(&env.as_str()),
                        depth + 1,
                    );
                    if !text.trim().is_empty() {
                        lines.extend(render_line(prefix, marker, false, "", text.trim()));
                        text.clear();
                    }
                    lines.extend(nested);
                    continue;
                }
                text.push_str(&markdown_escape(&format!("\\begin{{{env}}}{body}")));
                continue;
            }
            let character = cursor.bump().unwrap_or('\0');
            match character {
                '\\' => {
                    if let Some(markdown) = self.read_command(&mut cursor) {
                        text.push_str(&markdown);
                    }
                }
                '$' => {
                    let body = cursor.read_until_char('$');
                    text.push_str(&markdown_code_span(&format!("${body}$")));
                    self.out
                        .degrade("数学公式已降级保存为代码内容，公式源码未丢失。");
                }
                '{' | '}' => {}
                '\n' => {
                    cursor.skip_whitespace_run();
                    text.push(' ');
                }
                '%' => {
                    cursor.read_until_newline();
                }
                other => text.push_str(&markdown_escape(&other.to_string())),
            }
        }
    }

    /// 读一个命令（调用方已消费反斜杠），返回要写进正文的 markdown。
    fn read_command(&mut self, cursor: &mut Cursor) -> Option<String> {
        // `\\` 换行：markdown 软换行，不写入原始 HTML。
        if cursor.skip_if('\\') {
            cursor.skip_star();
            cursor.read_optional_group();
            return Some("\n".to_owned());
        }
        let name = cursor.read_command_name();
        if name.is_empty() {
            return Some(String::new());
        }
        for (command, open, close) in EMPHASIS {
            if name == command {
                let inner = cursor.read_group().unwrap_or_default();
                let content = self.convert_inline(&inner).unwrap_or_default();
                if content.trim().is_empty() {
                    return Some(String::new());
                }
                return Some(format!("{open}{content}{close}"));
            }
        }
        if FLATTENED.contains(&name.as_str()) {
            if name == "textcolor" || name == "colorbox" {
                cursor.read_group();
                self.out
                    .warn("LaTeX 的颜色与底纹样式不导入正文（排版样式由 Workbench 控制）。");
            } else if matches!(name.as_str(), "uline" | "underline") {
                self.out
                    .degrade("下划线没有 markdown 对应，已按普通文本保留。");
            } else if matches!(name.as_str(), "textsuperscript" | "textsubscript") {
                self.out.degrade("上标 / 下标已按普通文本保留。");
            }
            let mut args = String::new();
            while let Some(group) = cursor.read_optional_group_or_group() {
                args.push_str(&group);
                args.push(' ');
            }
            return Some(self.convert_inline(&args).unwrap_or_default());
        }
        if let Some((_, value)) = SYMBOLS.iter().find(|(command, _)| *command == name) {
            return Some(markdown_escape(value));
        }
        if SPACING.contains(&name.as_str()) {
            if name == "hspace" {
                cursor.read_group();
            }
            return Some(" ".to_owned());
        }
        if LITERAL_ESCAPES.contains(&name.as_str()) {
            return Some(markdown_escape(&name));
        }
        if name == "(" {
            let body = cursor.read_until_str("\\)");
            self.out
                .degrade("数学公式已降级保存为代码内容，公式源码未丢失。");
            return Some(markdown_code_span(&format!("\\({body}\\)")));
        }
        if matches!(name.as_str(), "texttt" | "tt" | "verb" | "verb*") {
            if name == "verb" || name == "verb*" {
                cursor.skip_star();
                let delimiter = cursor.bump().unwrap_or('|');
                let body = cursor.read_until_char(delimiter);
                return Some(markdown_code_span(&body));
            }
            let inner = cursor.read_group().unwrap_or_default();
            let content = self.convert_inline(&inner).unwrap_or_default();
            return Some(markdown_code_span(&content));
        }
        if name == "href" {
            let target = cursor.read_group().unwrap_or_default();
            let label = cursor.read_group().unwrap_or_default();
            let label = self.convert_inline(&label).unwrap_or_default();
            let label = if label.trim().is_empty() {
                markdown_escape(target.trim())
            } else {
                label
            };
            return Some(format!(
                "[{}]({})",
                label.replace('[', "(").replace(']', ")"),
                target.trim()
            ));
        }
        if matches!(name.as_str(), "url" | "path") {
            let target = cursor.read_group().unwrap_or_default();
            let target = target.trim().to_owned();
            return Some(format!("[{}]({})", markdown_escape(&target), target));
        }
        if matches!(
            name.as_str(),
            "nolinkurl" | "textup" | "mbox" | "textnormal"
        ) {
            let inner = cursor.read_group().unwrap_or_default();
            return Some(self.convert_inline(&inner).unwrap_or_default());
        }
        if matches!(name.as_str(), "footnote" | "footnotetext") {
            cursor.read_optional_group();
            let inner = cursor.read_group().unwrap_or_default();
            let content = self.convert_inline(&inner).unwrap_or_default();
            self.footnotes += 1;
            return Some(format!("（脚注：{content}）"));
        }
        if CROSS_REFERENCE_COMMANDS.contains(&name.as_str()) {
            cursor.read_optional_group();
            let keys = cursor.read_group().unwrap_or_default();
            self.cross_references += 1;
            return Some(markdown_escape(&format!("\\{name}{{{keys}}}")));
        }
        if INCLUDE_COMMANDS.contains(&name.as_str()) {
            let target = cursor.read_group().unwrap_or_default();
            self.out.degrade(format!(
                "文件包含命令 \\{name}{{{target}}} 未展开（导入不读取磁盘上的其他文件），已保留原文。"
            ));
            return Some(markdown_escape(&format!("\\{name}{{{target}}}")));
        }
        if name == "includegraphics" {
            let options = cursor.read_optional_group();
            if let Some(target) = cursor
                .read_group()
                .filter(|target| !target.trim().is_empty())
            {
                let target = target.trim();
                let href = markdown_image_href(target);
                let alt = target
                    .rsplit('/')
                    .next()
                    .filter(|value| !value.is_empty())
                    .unwrap_or("图片");
                return Some(format!("![{}](<{href}>)", markdown_escape(alt)));
            }
            let suffix = options
                .map(|value| format!("[{value}]"))
                .unwrap_or_default();
            self.out.degrade(format!(
                "LaTeX 图片命令参数无法识别，已保留原文：\\includegraphics{suffix}"
            ));
            return Some(markdown_escape(&format!("\\includegraphics{suffix}")));
        }
        if GRAPHICS_COMMANDS.contains(&name.as_str()) {
            let mut args = String::new();
            while let Some(group) = cursor.read_optional_group_or_group() {
                args.push('{');
                args.push_str(&group);
                args.push('}');
            }
            self.out.degrade(format!(
                "LaTeX 引用的外部图片未读取（导入不访问源文件目录），已保留命令原文：\\{name}{args}"
            ));
            return Some(markdown_escape(&format!("\\{name}{args}")));
        }
        if matches!(
            name.as_str(),
            "newpage" | "clearpage" | "pagebreak" | "linebreak"
        ) {
            self.page_breaks += 1;
            return Some(String::new());
        }
        if IGNORED_COMMANDS.contains(&name.as_str())
            || NON_CONTENT_COMMANDS.contains(&name.as_str())
        {
            self.dropped_commands += 1;
            cursor.consume_group_args();
            if matches!(
                name.as_str(),
                "maketitle"
                    | "tableofcontents"
                    | "listoffigures"
                    | "listoftables"
                    | "printbibliography"
            ) {
                self.out
                    .warn(format!("\\{name} 由文档结构生成，未导入正文。"));
            }
            return Some(String::new());
        }
        if name == "par" {
            return Some("\n\n".to_owned());
        }
        if name == "item" {
            // 列表环境之外的 \item：按可读原文保留。
            let label = cursor.read_optional_group().unwrap_or_default();
            self.unknown_macros.insert("item".to_owned());
            return Some(markdown_escape(&format!("\\item[{label}]")));
        }
        // 未知命令：连同紧跟的参数一起按原文保留（可读优先）。
        self.unknown_macros.insert(name.clone());
        let mut rebuilt = format!("\\{name}");
        while let Some(group) = cursor.read_optional_group_or_group() {
            rebuilt.push('{');
            rebuilt.push_str(&group);
            rebuilt.push('}');
        }
        Some(markdown_escape(&rebuilt))
    }

    /// 行内转换：把一段 LaTeX 源文本变成 markdown 行内文本。
    fn convert_inline(&mut self, source: &str) -> Option<String> {
        let chars: Vec<char> = source.chars().collect();
        let mut cursor = Cursor::new(&chars);
        let mut out = String::new();
        while !cursor.eof() {
            let character = cursor.bump().unwrap_or('\0');
            match character {
                '\\' => {
                    if let Some(markdown) = self.read_command(&mut cursor) {
                        out.push_str(&markdown);
                    }
                }
                '$' => {
                    let body = cursor.read_until_char('$');
                    out.push_str(&markdown_code_span(&format!("${body}$")));
                    self.out
                        .degrade("数学公式已降级保存为代码内容，公式源码未丢失。");
                }
                '{' | '}' => {}
                '\n' => {
                    if cursor.at_blank_line_run() {
                        cursor.skip_whitespace_run();
                        out.push_str("\n\n");
                    } else {
                        cursor.skip_whitespace_run();
                        out.push(' ');
                    }
                }
                '%' => {
                    cursor.read_until_newline();
                }
                '-' => {
                    if cursor.starts_with("--") {
                        cursor.pos += 2;
                        if cursor.starts_with("-") {
                            cursor.pos += 1;
                            out.push('—');
                        } else {
                            out.push('–');
                        }
                    } else {
                        out.push('-');
                    }
                }
                other => out.push_str(&markdown_escape(&other.to_string())),
            }
        }
        if out.trim().is_empty() {
            None
        } else {
            Some(out)
        }
    }

    /// `tabular` -> GFM 管道表格；第一行当表头。
    fn build_table(&mut self, body: &str) -> Option<String> {
        let mut rows: Vec<String> = Vec::new();
        for row in split_top_level(body, "\\\\") {
            let cleaned = strip_rule_lines(&row);
            if cleaned.trim().is_empty() {
                continue;
            }
            if count_multicolumn(&cleaned) > 1 {
                self.merged_cells += 1;
            }
            rows.push(cleaned);
        }
        if rows.is_empty() {
            return None;
        }
        let parsed: Vec<Vec<String>> = rows
            .iter()
            .map(|row| {
                split_top_level(row, "&")
                    .into_iter()
                    .map(|cell| self.flatten_cell(&cell))
                    .collect()
            })
            .collect();
        let columns = parsed.iter().map(|row| row.len()).max().unwrap_or(0);
        if columns == 0 {
            return None;
        }
        let mut lines: Vec<String> = Vec::new();
        for (index, row) in parsed.iter().enumerate() {
            let mut cells = row.clone();
            cells.resize(columns, String::new());
            for cell in &mut cells {
                if cell.is_empty() {
                    *cell = " ".to_owned();
                }
            }
            lines.push(format!("| {} |", cells.join(" | ")));
            if index == 0 {
                lines.push(format!("| {} |", vec!["---"; columns].join(" | ")));
            }
        }
        Some(lines.join("\n"))
    }

    fn flatten_cell(&mut self, cell: &str) -> String {
        let trimmed = cell.trim();
        if let Some(rest) = trimmed.strip_prefix("\\multicolumn") {
            self.merged_cells += 1;
            let units: Vec<char> = rest.chars().collect();
            let mut cursor = Cursor::new(&units);
            let mut text = String::new();
            for _ in 0..3 {
                match cursor.read_group() {
                    Some(group) => text = group,
                    None => break,
                }
            }
            return sanitize_cell(&self.convert_inline(&text).unwrap_or_default());
        }
        sanitize_cell(&self.convert_inline(trimmed).unwrap_or_default())
    }
}

/// Encode filesystem paths as safe Markdown destinations. The importer decodes
/// percent escapes before applying its canonical-root and symlink checks.
fn markdown_image_href(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn render_line(
    prefix: &str,
    marker: &str,
    described: bool,
    label: &str,
    text: &str,
) -> Option<String> {
    let body = text.trim();
    if described && !label.trim().is_empty() {
        let term = markdown_escape(label.trim());
        return Some(if body.is_empty() {
            format!("{prefix}{marker} **{term}**")
        } else {
            format!("{prefix}{marker} **{term}** {body}")
        });
    }
    if body.is_empty() {
        return None;
    }
    Some(format!("{prefix}{marker} {body}"))
}

fn math_item(source: String) -> Item {
    Item {
        kind: Kind::Code,
        content: source,
        level: None,
        language: Some("latex".to_owned()),
    }
}

/// 嵌套场景把条目串成 markdown 文本（引用块内、列表项内）。
fn join_items(items: &[Item]) -> String {
    items
        .iter()
        .map(|item| match item.kind {
            Kind::Heading => format!("**{}**", item.content),
            Kind::Code => {
                let fence = super::code_fence(&item.content);
                let language = item.language.clone().unwrap_or_default();
                format!("{fence}{language}\n{}\n{fence}", item.content)
            }
            Kind::Quote => item
                .content
                .lines()
                .map(|line| format!("> {line}"))
                .collect::<Vec<_>>()
                .join("\n"),
            other => {
                let _ = other;
                item.content.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn sectioning_at(cursor: &Cursor) -> Option<(String, u64)> {
    for (name, level) in SECTIONING {
        let command = format!("\\{name}");
        if !cursor.starts_with(&command) {
            continue;
        }
        if matches!(cursor.at(command.chars().count()), Some(value) if value.is_ascii_alphabetic())
        {
            continue;
        }
        return Some((command, level));
    }
    None
}

/// 把环境体开头的 `[选项]` 与 `{参数}` 拆出来（lstlisting / minted / tabular 需要）。
fn split_env_args(body: &str, env: &str) -> (String, String) {
    let chars: Vec<char> = body.chars().collect();
    let mut cursor = Cursor::new(&chars);
    let mut args = String::new();
    cursor.skip_leading_whitespace();
    if let Some(optional) = cursor.read_optional_group() {
        args.push_str(&optional);
        args.push(' ');
    }
    if matches!(
        env,
        "minted"
            | "minted*"
            | "lstlisting"
            | "listings"
            | "tabular"
            | "tabular*"
            | "tabularx"
            | "longtable"
            | "array"
            | "tabu"
    ) {
        cursor.skip_leading_whitespace();
        if let Some(mandatory) = cursor.read_group() {
            args.push_str(&mandatory);
            args.push(' ');
        }
    }
    let rest = chars[cursor.pos.min(chars.len())..].iter().collect();
    (args.trim().to_owned(), rest)
}

fn code_language(env: &str, args: &str) -> Option<String> {
    let lower = args.to_ascii_lowercase();
    if let Some(index) = lower.find("language=") {
        let tail = &args[index + "language=".len()..];
        let token = tail
            .trim_start_matches(['=', ' ', '{', '"'])
            .split(|c: char| c == '}' || c == ',' || c == '"')
            .next()
            .unwrap_or_default()
            .trim();
        if !token.is_empty() {
            return Some(token.to_ascii_lowercase());
        }
    }
    if matches!(env, "minted" | "minted*") {
        return args
            .split_whitespace()
            .next()
            .map(|value| value.trim_matches(['{', '}']).to_ascii_lowercase());
    }
    None
}

/// 去掉行内所有排版规则命令（`\hline` / `\cline{..}` / `\toprule` 等）。
fn strip_rule_lines(row: &str) -> String {
    let mut out = String::with_capacity(row.len());
    let chars: Vec<char> = row.chars().collect();
    let mut cursor = Cursor::new(&chars);
    while !cursor.eof() {
        let character = cursor.bump().unwrap_or('\0');
        if character != '\\' {
            out.push(character);
            continue;
        }
        let name = cursor.read_command_name();
        if matches!(
            name.as_str(),
            "hline" | "cline" | "toprule" | "midrule" | "bottomrule" | "hhline" | "arrayslashrule"
        ) {
            cursor.consume_group_args();
            continue;
        }
        if name.is_empty() {
            out.push('\\');
            continue;
        }
        out.push('\\');
        out.push_str(&name);
    }
    out
}

fn count_multicolumn(row: &str) -> usize {
    row.matches("\\multicolumn").count()
}

fn sanitize_cell(text: &str) -> String {
    text.chars()
        .filter(|character| !character.is_control() && *character != '\n')
        .collect::<String>()
        .replace('|', "\\|")
        .trim()
        .to_owned()
}

/// 只在花括号层级外分割。
fn split_top_level(source: &str, separator: &str) -> Vec<String> {
    let chars: Vec<char> = source.chars().collect();
    let sep: Vec<char> = separator.chars().collect();
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    let mut index = 0usize;
    while index < chars.len() {
        // 先判分隔符：`\\` 既是行分隔符，也长得像"转义对"，顺序颠倒会把整张表并成一行。
        if depth == 0 && starts_with_at(&chars, index, &sep) {
            parts.push(std::mem::take(&mut current));
            index += sep.len();
            continue;
        }
        if chars[index] == '\\'
            && index + 1 < chars.len()
            && !chars[index + 1].is_whitespace()
            && !chars[index + 1].is_ascii_alphabetic()
        {
            current.push(chars[index]);
            current.push(chars[index + 1]);
            index += 2;
            continue;
        }
        match chars[index] {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        current.push(chars[index]);
        index += 1;
    }
    if !current.trim().is_empty() || parts.is_empty() {
        parts.push(current);
    }
    parts
}

fn starts_with_at(haystack: &[char], index: usize, needle: &[char]) -> bool {
    needle
        .iter()
        .enumerate()
        .all(|(offset, character)| haystack.get(index + offset) == Some(character))
}

/// 去掉注释（`%` 到行尾），保留 `\%` 转义；返回新文本与注释数量。
fn strip_comments(source: &str) -> (String, usize) {
    let mut out = String::with_capacity(source.len());
    let mut comments = 0usize;
    let mut skip_to_newline = false;
    let mut previous = '\0';
    for character in source.chars() {
        if skip_to_newline {
            if character == '\n' {
                skip_to_newline = false;
                out.push('\n');
            }
            previous = character;
            continue;
        }
        if character == '%' && previous != '\\' {
            skip_to_newline = true;
            comments += 1;
            previous = character;
            continue;
        }
        out.push(character);
        previous = character;
    }
    (out, comments)
}

/// `Vec<char>` 上的游标：所有 LaTeX 词法读取都走这里，越界一律返回 `None`。
struct Cursor<'a> {
    chars: &'a [char],
    pos: usize,
}

impl Cursor<'_> {
    fn new(chars: &[char]) -> Cursor<'_> {
        Cursor { chars, pos: 0 }
    }

    fn eof(&self) -> bool {
        self.pos >= self.chars.len()
    }

    fn at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    fn starts_with(&self, needle: &str) -> bool {
        let values: Vec<char> = needle.chars().collect();
        starts_with_at(self.chars, self.pos, &values)
    }

    fn bump(&mut self) -> Option<char> {
        let value = self.chars.get(self.pos).copied();
        if value.is_some() {
            self.pos += 1;
        }
        value
    }

    fn skip_if(&mut self, expected: char) -> bool {
        if self.chars.get(self.pos) == Some(&expected) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn skip_star(&mut self) {
        self.skip_if('*');
    }

    fn skip_leading_whitespace(&mut self) {
        while matches!(self.chars.get(self.pos), Some(value) if value.is_whitespace()) {
            self.pos += 1;
        }
    }

    /// 命令名：连续字母；非字母命令（`\,`、`\%`）读单个字符。
    fn read_command_name(&mut self) -> String {
        let mut name = String::new();
        while let Some(value) = self.chars.get(self.pos) {
            if value.is_ascii_alphabetic() || *value == '*' {
                name.push(*value);
                self.pos += 1;
            } else {
                break;
            }
        }
        if name.is_empty() {
            if let Some(value) = self.bump() {
                name.push(value);
            }
        }
        name
    }

    fn read_command_name_like(&mut self, stop: char) -> String {
        let mut name = String::new();
        while let Some(value) = self.chars.get(self.pos) {
            if *value == stop {
                break;
            }
            name.push(*value);
            self.pos += 1;
        }
        name
    }

    /// 读到未转义的 `stop` 为止（用于 `$...$`、`\verb|...|`）。
    fn read_until_char(&mut self, stop: char) -> String {
        let start = self.pos;
        let mut index = self.pos;
        while index < self.chars.len() {
            if self.chars[index] == '\\' && index + 1 < self.chars.len() {
                index += 2;
                continue;
            }
            if self.chars[index] == stop {
                break;
            }
            index += 1;
        }
        let body: String = self.chars[start..index.min(self.chars.len())]
            .iter()
            .collect();
        self.pos = if index < self.chars.len() {
            index + 1
        } else {
            self.chars.len()
        };
        body
    }

    fn read_until_str(&mut self, stop: &str) -> String {
        let values: Vec<char> = stop.chars().collect();
        let start = self.pos;
        let mut index = self.pos;
        while index < self.chars.len() {
            if starts_with_at(self.chars, index, &values) {
                break;
            }
            index += 1;
        }
        let body: String = self.chars[start..index].iter().collect();
        self.pos = if index < self.chars.len() {
            index + values.len()
        } else {
            self.chars.len()
        };
        body
    }

    fn read_until_newline(&mut self) -> String {
        let start = self.pos;
        while matches!(self.chars.get(self.pos), Some(value) if *value != '\n') {
            self.pos += 1;
        }
        self.chars[start..self.pos].iter().collect()
    }

    /// `\begin{env}` 的正文：按同名环境计数嵌套，返回体内容与是否闭合。
    fn read_env_body(&mut self, env: &str) -> (String, bool) {
        let start = self.pos;
        let env_chars: Vec<char> = env.chars().collect();
        let begin: Vec<char> = "\\begin{".chars().collect();
        let end: Vec<char> = "\\end{".chars().collect();
        let mut depth = 1usize;
        let mut index = self.pos;
        while index < self.chars.len() {
            if starts_with_at(self.chars, index, &begin) || starts_with_at(self.chars, index, &end)
            {
                let is_end = starts_with_at(self.chars, index, &end);
                let name_start = index + if is_end { end.len() } else { begin.len() };
                let mut name_end = name_start;
                while self.chars.get(name_end) != Some(&'}') && name_end < self.chars.len() {
                    name_end += 1;
                }
                if name_start <= self.chars.len()
                    && name_end <= self.chars.len()
                    && self.chars.get(name_start..name_end) == Some(&env_chars[..])
                {
                    if is_end {
                        depth -= 1;
                        if depth == 0 {
                            let body: String = self.chars[start..index].iter().collect();
                            self.pos = (name_end + 1).min(self.chars.len());
                            return (body, true);
                        }
                    } else {
                        depth += 1;
                    }
                }
                index = name_end + 1;
                continue;
            }
            index += 1;
        }
        let body: String = self.chars[start..].iter().collect();
        self.pos = self.chars.len();
        (body, false)
    }

    /// 顶层 `{...}` 组；游标不在 `{` 时返回 `None`。
    fn read_group(&mut self) -> Option<String> {
        self.skip_leading_whitespace();
        if self.chars.get(self.pos) != Some(&'{') {
            return None;
        }
        self.pos += 1;
        let start = self.pos;
        let mut depth = 1i32;
        while let Some(value) = self.chars.get(self.pos) {
            match value {
                '\\' => {
                    self.pos = self.pos.saturating_add(2);
                    continue;
                }
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            self.pos += 1;
        }
        let end = self.pos.min(self.chars.len());
        let body: String = self.chars[start.min(end)..end].iter().collect();
        if self.chars.get(self.pos) == Some(&'}') {
            self.pos += 1;
        }
        Some(body)
    }

    /// 顶层 `[...]` 可选参数。
    fn read_optional_group(&mut self) -> Option<String> {
        self.skip_leading_whitespace();
        if self.chars.get(self.pos) != Some(&'[') {
            return None;
        }
        self.pos += 1;
        let start = self.pos;
        let mut depth = 1i32;
        while let Some(value) = self.chars.get(self.pos) {
            match value {
                '[' => depth += 1,
                ']' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                _ => {}
            }
            self.pos += 1;
        }
        let end = self.pos.min(self.chars.len());
        let body: String = self.chars[start.min(end)..end].iter().collect();
        if self.chars.get(self.pos) == Some(&']') {
            self.pos += 1;
        }
        Some(body)
    }

    fn read_optional_group_or_group(&mut self) -> Option<String> {
        let save = self.pos;
        if let Some(optional) = self.read_optional_group() {
            return Some(optional);
        }
        if let Some(group) = self.read_group() {
            return Some(group);
        }
        self.pos = save;
        None
    }

    /// 吞掉紧跟命令的参数（用于忽略声明 / 排版类命令）。
    fn consume_group_args(&mut self) {
        let mut guard = 0usize;
        while guard < 8 {
            guard += 1;
            let save = self.pos;
            if self.read_optional_group_or_group().is_none() {
                self.pos = save;
                break;
            }
        }
    }

    /// 空行（>=2 个换行）判定；游标停在第一个换行之后。
    fn at_blank_line_run(&self) -> bool {
        let mut index = self.pos;
        let mut newlines = 0usize;
        while let Some(value) = self.chars.get(index) {
            match value {
                '\n' => newlines += 1,
                ' ' | '\t' | '\r' => {}
                _ => break,
            }
            index += 1;
        }
        newlines >= 1
    }

    fn skip_whitespace_run(&mut self) {
        while matches!(self.chars.get(self.pos), Some(value) if value.is_whitespace()) {
            self.pos += 1;
        }
    }

    /// 取到下一个顶层 `\item` 之前的内容；游标停在 `\item` 上（未消费）。
    fn take_until_item(&mut self) -> String {
        let start = self.pos;
        let marker: Vec<char> = "\\item".chars().collect();
        let begin: Vec<char> = "\\begin{".chars().collect();
        let mut index = self.pos;
        let mut depth = 0i32;
        while index < self.chars.len() {
            match self.chars[index] {
                '{' => depth += 1,
                '}' => depth -= 1,
                '\\' => {
                    // 整段跳过嵌套环境：内层列表的 `\item` 不是当前层的分隔点。
                    if depth == 0 && starts_with_at(self.chars, index, &begin) {
                        index = matching_env_end(self.chars, index)
                            .unwrap_or(self.chars.len())
                            .max(index + 1);
                        continue;
                    }
                    if depth == 0
                        && starts_with_at(self.chars, index, &marker)
                        && !matches!(self.chars.get(index + marker.len()), Some(value) if value.is_ascii_alphabetic())
                    {
                        break;
                    }
                    index += 1;
                    continue;
                }
                _ => {}
            }
            index += 1;
        }
        let body: String = self.chars[start..index].iter().collect();
        self.pos = index;
        body
    }
}

/// 从 `\begin{env}` 的起始下标跳到配对 `\end{env}` 之后的位置（同名环境计数嵌套）。
/// 未闭合时返回 `None`，调用方按"读到结尾"处理。
fn matching_env_end(chars: &[char], begin_index: usize) -> Option<usize> {
    let begin: Vec<char> = "\\begin{".chars().collect();
    let end: Vec<char> = "\\end{".chars().collect();
    let name_start = begin_index + begin.len();
    let mut name_end = name_start;
    while chars.get(name_end) != Some(&'}') {
        if name_end >= chars.len() {
            return None;
        }
        name_end += 1;
    }
    let env: Vec<char> = chars.get(name_start..name_end)?.to_vec();
    let mut depth = 1usize;
    let mut index = name_end + 1;
    while index < chars.len() {
        if starts_with_at(chars, index, &begin) || starts_with_at(chars, index, &end) {
            let is_end = starts_with_at(chars, index, &end);
            let inner_start = index + if is_end { end.len() } else { begin.len() };
            let mut inner_end = inner_start;
            while chars.get(inner_end) != Some(&'}') {
                if inner_end >= chars.len() {
                    return None;
                }
                inner_end += 1;
            }
            if chars.get(inner_start..inner_end) == Some(&env[..]) {
                if is_end {
                    depth -= 1;
                    if depth == 0 {
                        return Some(inner_end + 1);
                    }
                } else {
                    depth += 1;
                }
            }
            index = inner_end + 1;
            continue;
        }
        index += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::{parse_document, ParsedDocument};

    fn kinds(parsed: &ParsedDocument) -> Vec<String> {
        parsed
            .blocks
            .iter()
            .map(|block| {
                let kind = block["type"].as_str().unwrap_or_default();
                match block["level"].as_u64() {
                    Some(level) => format!("{kind}:{level}"),
                    None => kind.to_owned(),
                }
            })
            .collect()
    }

    fn text(parsed: &ParsedDocument, index: usize) -> String {
        parsed
            .blocks
            .get(index)
            .and_then(|block| block["text"].as_str())
            .unwrap_or_default()
            .to_owned()
    }

    fn raw(parsed: &ParsedDocument, index: usize) -> String {
        parsed
            .blocks
            .get(index)
            .and_then(|block| block["raw"].as_str())
            .unwrap_or_default()
            .to_owned()
    }

    fn parse(source: &str) -> ParsedDocument {
        parse_document("lecture.tex", source.as_bytes()).expect("latex 应解析成功")
    }

    #[test]
    fn latex_recognizes_sectioning_and_paragraphs() {
        let parsed = parse(
            "\\documentclass{article}\n\\usepackage{amsmath}\n\\title{T}\n\\begin{document}\n\\section{绪论}\n\n第一段文字。\n\n\\subsection{范围}\n\n第二段文字。\n\\end{document}\n",
        );
        assert_eq!(
            kinds(&parsed),
            vec!["heading:2", "paragraph", "heading:3", "paragraph"]
        );
        assert_eq!(text(&parsed, 0), "绪论");
        assert_eq!(raw(&parsed, 0), "## 绪论\n");
        assert_eq!(text(&parsed, 1), "第一段文字。");
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("导言区")));
    }

    #[test]
    fn latex_maps_part_and_chapter_to_top_levels() {
        let parsed =
            parse("\\part{第一部}\n\n\\chapter{第一章}\n\n\\subsubsection{细节}\n\n正文\n");
        assert_eq!(
            kinds(&parsed),
            vec!["heading:1", "heading:1", "heading:4", "paragraph"]
        );
    }

    #[test]
    fn latex_converts_itemize_with_nested_enumerate() {
        let parsed = parse(
            "\\begin{itemize}\n  \\item 第一点\n  \\item 第二点\n  \\begin{enumerate}\n    \\item 子项一\n    \\item 子项二\n  \\end{enumerate}\n\\end{itemize}\n",
        );
        assert_eq!(kinds(&parsed), vec!["list"]);
        assert_eq!(
            raw(&parsed, 0),
            "- 第一点\n- 第二点\n  1. 子项一\n  1. 子项二\n"
        );
    }

    #[test]
    fn latex_renders_enumerate_and_description() {
        let parsed = parse(
            "\\begin{enumerate}\n\\item 甲\n\\item 乙\n\\end{enumerate}\n\n\\begin{description}\n\\item[目的] 学会导入\n\\item[方法] 动手练习\n\\end{description}\n",
        );
        assert_eq!(kinds(&parsed), vec!["list", "list"]);
        assert_eq!(raw(&parsed, 0), "1. 甲\n1. 乙\n");
        assert_eq!(
            raw(&parsed, 1),
            "- **目的** 学会导入\n- **方法** 动手练习\n"
        );
    }

    #[test]
    fn latex_preserves_inline_formatting_and_links() {
        let parsed = parse(
            r"这是 \textbf{重点}、\emph{强调} 与 \texttt{代码}，还有 \href{https://example.com}{示例站点}。\textit{尾巴}",
        );
        assert_eq!(kinds(&parsed), vec!["paragraph"]);
        let content = text(&parsed, 0);
        assert!(content.contains("**重点**"), "{content}");
        assert!(content.contains("*强调*"), "{content}");
        assert!(content.contains("`代码`"), "{content}");
        assert!(
            content.contains("[示例站点](https://example.com)"),
            "{content}"
        );
        assert!(content.contains("*尾巴*"), "{content}");
    }

    #[test]
    fn latex_degrades_inline_math_but_keeps_source() {
        let parsed = parse("能量公式 $E = mc^2$ 很有名。");
        assert_eq!(kinds(&parsed), vec!["paragraph"]);
        assert!(text(&parsed, 0).contains("`$E = mc^2$`"));
        assert!(parsed.degraded);
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("数学公式已降级保存")));
    }

    #[test]
    fn latex_degrades_display_math_and_environments() {
        let parsed = parse(
            "先看公式：\n\n\\begin{equation}\n\\label{eq:1}\n  \\frac{a}{b} = c\n\\end{equation}\n\n\\[ x^2 + y^2 = z^2 \\]\n",
        );
        assert_eq!(kinds(&parsed), vec!["paragraph", "code", "code"]);
        assert_eq!(
            parsed.blocks[1]["language"].as_str(),
            Some("latex"),
            "数学块应标语言"
        );
        assert!(text(&parsed, 1).contains("\\frac{a}{b} = c"));
        assert!(text(&parsed, 1).contains("\\begin{equation}"));
        assert!(text(&parsed, 2).contains("x^2 + y^2"));
        assert!(raw(&parsed, 2).starts_with("```latex"));
        assert!(parsed.degraded);
    }

    #[test]
    fn latex_quote_and_verbatim_environments() {
        let parsed = parse(
            "\\begin{quote}\n被人引用的话。\n\\end{quote}\n\n\\begin{verbatim}\nif x > 3: print(x)\n\\end{verbatim}\n\n\\begin{lstlisting}[language=Python]\nprint(\"hi\")\n\\end{lstlisting}\n",
        );
        assert_eq!(kinds(&parsed), vec!["quote", "code", "code"]);
        assert_eq!(text(&parsed, 0), "被人引用的话。");
        assert_eq!(raw(&parsed, 0), "> 被人引用的话。\n");
        assert_eq!(parsed.blocks[1]["language"], serde_json::Value::Null);
        assert_eq!(parsed.blocks[2]["language"].as_str(), Some("python"));
        assert!(text(&parsed, 2).contains("print(\"hi\")"));
        // 逐字内容不做宏展开
        assert!(text(&parsed, 1).contains("if x > 3"));
    }

    #[test]
    fn latex_tabular_becomes_gfm_table() {
        let parsed = parse(
            "\\begin{tabular}{|l|r|}\n\\hline\n名称 & 数量 \\\\\n甲 & 3 \\\\\n乙 & 12 \\\\\n\\hline\n\\end{tabular}\n",
        );
        assert_eq!(kinds(&parsed), vec!["table"]);
        let content = raw(&parsed, 0);
        assert!(content.contains("| 名称 | 数量 |"), "{content}");
        assert!(content.contains("| --- | --- |"), "{content}");
        assert!(content.contains("| 甲 | 3 |"), "{content}");
        assert!(content.contains("| 乙 | 12 |"), "{content}");
    }

    #[test]
    fn latex_multicolumn_is_flattened_with_warning() {
        let parsed = parse(
            "\\begin{tabular}{ll}\n\\multicolumn{2}{c}{合计} \\\\甲 & 3 \\\\\n\\end{tabular}\n",
        );
        assert_eq!(kinds(&parsed), vec!["table"]);
        assert!(parsed.degraded);
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("合并单元格")));
    }

    #[test]
    fn latex_unknown_macro_keeps_readable_text_with_warning() {
        let parsed = parse("这里用了 \\myemph{重要词} 和 \\RR 符号。");
        let content = text(&parsed, 0);
        assert!(content.contains("\\\\myemph\\{重要词\\}"), "{content}");
        assert!(parsed.degraded);
        let warning = parsed
            .warnings
            .iter()
            .find(|warning| warning.contains("无法识别的 LaTeX 命令"))
            .expect("应有未知命令提示");
        assert!(
            warning.contains("\\myemph") && warning.contains("\\RR"),
            "{warning}"
        );
    }

    #[test]
    fn latex_unknown_environment_keeps_content_as_blocks() {
        let parsed =
            parse("\\begin{mytheorem}\n定理内容。\n\n\\textbf{要点}。\n\\end{mytheorem}\n");
        assert_eq!(kinds(&parsed), vec!["paragraph", "paragraph"]);
        assert_eq!(text(&parsed, 0), "定理内容。");
        assert!(parsed.degraded);
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("mytheorem")));
    }

    #[test]
    fn latex_comments_and_tex_escapes_are_literal() {
        let parsed =
            parse("百分号 50\\% 与 下划线 a\\_b 以及 \\& 符号。\\{花括号\\}\n% 这是注释\n\n下一段");
        let content = text(&parsed, 0);
        assert!(content.contains("50%"), "{content}");
        assert!(content.contains("a\\_b"), "{content}");
        assert!(content.contains("&"), "{content}");
        assert!(content.contains("\\{花括号\\}"), "{content}");
        assert_eq!(parsed.blocks.len(), 2);
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("LaTeX 注释")));
    }

    #[test]
    fn latex_never_touches_disk_for_includes_and_graphics() {
        let parsed =
            parse("\\input{chapter2.tex}\n\n\\includegraphics[width=2cm]{fig1.pdf}\n\n正文\n");
        assert!(parsed.degraded);
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("未展开（导入不读取磁盘上的其他文件）")));
        assert!(!parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("外部图片未读取（导入不访问源文件目录）")));
        assert!(parsed.blocks.iter().any(|block| block["text"]
            .as_str()
            .unwrap_or_default()
            .contains("chapter2")));
        assert!(parsed.blocks.iter().any(|block| block["text"]
            .as_str()
            .unwrap_or_default()
            .contains("![fig1\\.pdf](<fig1.pdf>)")));
    }

    #[test]
    fn latex_includegraphics_emits_a_percent_encoded_local_image_reference() {
        let parsed = parse("\\includegraphics[width=2cm]{../images/图 1.png}\n");
        assert_eq!(parsed.blocks.len(), 1);
        assert_eq!(
            text(&parsed, 0),
            "![图 1\\.png](<../images/%E5%9B%BE%201.png>)"
        );
        assert!(parsed.warnings.is_empty(), "{:?}", parsed.warnings);
    }

    #[test]
    fn latex_footnote_and_cross_reference_are_inlined() {
        let parsed = parse("重要结论\\footnote{见参考资料}\n\n如 \\ref{sec:x} 所述\n");
        assert!(parsed.degraded);
        assert!(
            text(&parsed, 0).contains("（脚注：见参考资料）"),
            "{}",
            text(&parsed, 0)
        );
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("交叉引用")));
    }

    #[test]
    fn latex_tolerates_unterminated_environment_and_garbage_bytes() {
        let parsed = parse("\\begin{itemize}\n\\item 只有一项\n");
        assert_eq!(kinds(&parsed), vec!["list"]);
        assert!(parsed
            .warnings
            .iter()
            .any(|warning| warning.contains("缺少对应的")));
        assert_eq!(text(&parsed, 0), "- 只有一项");
        // 垃圾字节：要么 Err，要么是带提示的可解释结果，绝不 panic。
        let garbage = vec![0xC3u8, 0x28, 0x7A, 0x00, 0x00, 0xFF, 0xD8];
        let _ = parse_document("bad.tex", &garbage);
        assert!(parse_document("empty.tex", b"\\begin{document}\n\\end{document}\n").is_ok());
        // 多余的 \end 不应吞掉后续正文。
        let stray = parse("多余的结束\\end{document}\n\n还有正文\n");
        assert!(text(&stray, 0).contains("多余的结束"));
    }

    #[test]
    fn latex_block_and_table_helpers_are_pure() {
        assert_eq!(strip_comments("a % c\nb \\% d").0, "a \nb \\% d");
        assert_eq!(strip_comments("a % c\nb").1, 1);
        assert_eq!(split_top_level("a{b}x & c \\\\ d", "&").len(), 2);
        assert_eq!(split_top_level("x{y&z} w", "&").len(), 1);
        assert_eq!(code_language("minted", "python"), Some("python".to_owned()));
        assert_eq!(
            code_language("lstlisting", "language=Python"),
            Some("python".to_owned())
        );
        assert!(build_table_static("名称 & 数量 \\\\\n甲 & 3").is_some());
        assert!(build_table_static("\\hline").is_none());
        assert_eq!(sanitize_cell("a|b"), "a\\|b");
        assert_eq!(
            sectioning_at(&Cursor::new(&"\\subsection{x}".chars().collect::<Vec<_>>()))
                .map(|(_, level)| level),
            Some(3)
        );
    }

    fn build_table_static(body: &str) -> Option<String> {
        let mut collector = Collector::new();
        let mut parser = Parser {
            out: &mut collector,
            unknown_macros: BTreeSet::new(),
            unknown_envs: BTreeSet::new(),
            dropped_commands: 0,
            page_breaks: 0,
            cross_references: 0,
            footnotes: 0,
            merged_cells: 0,
            truncated: false,
        };
        parser.build_table(body)
    }
}
