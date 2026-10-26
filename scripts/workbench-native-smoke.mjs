/** Real Tauri/WebKit integration QA. Never installs a mock bridge or calls AI/search services. */
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

export class WebDriverClient {
  constructor(url, fetcher = globalThis.fetch) { this.url = url; this.fetcher = fetcher; this.session = null; }
  async command(method, path, body) {
    const response = await this.fetcher(this.url + path, {
      method, headers: {'content-type': 'application/json'},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok || result.value?.error) {
      throw new Error(`${result.value?.error || response.status}: ${result.value?.message || JSON.stringify(result)}`);
    }
    return result.value;
  }
  async sessionCommand(method, path, body) { return this.command(method, `/session/${this.session}${path}`, body); }
  async evaluate(script, args = []) { return this.sessionCommand('POST', '/execute/sync', {script, args}); }
  async evaluateAsync(script, args = []) {
    const result = await this.sessionCommand('POST', '/execute/async', {
      script: `const done = arguments[arguments.length - 1]; const args = Array.from(arguments).slice(0, -1);
Promise.resolve().then(async () => { ${script} }).then(value => done({ok:true,value:value ?? null}), error => done({ok:false,error:String(error?.message || error)}));`, args,
    });
    assert.equal(result?.ok, true, result?.error || 'Native WebView did not return an execution result');
    return result.value;
  }
  async element(selector) {
    const value = await this.sessionCommand('POST', '/element', {using: 'css selector', value: selector});
    return value['element-6066-11e4-a52e-4f735466cecf'];
  }
  async click(selector) { return this.sessionCommand('POST', `/element/${await this.element(selector)}/click`, {}); }
  async fill(selector, text) {
    await this.sessionCommand('POST', `/element/${await this.element(selector)}/clear`, {});
    return this.sessionCommand('POST', `/element/${await this.element(selector)}/value`, {text, value: [...text]});
  }
  async screenshot(path) {
    const bytes = Buffer.from(await this.sessionCommand('GET', '/screenshot'), 'base64');
    assert(bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'WebKit screenshot must be an actual PNG');
    await writeFile(path, bytes);
  }
}

export async function assertFileHash(path, expected) {
  const actual = createHash('sha256').update(await readFile(path)).digest('hex');
  assert.equal(actual, expected, `Native reported hash does not match bytes: ${path}`);
}

// Python's standard ZIP/XML libraries inspect the actual OOXML, not filenames alone.
export function validateNativeArtifacts(directory, expectedText, tail, sourceUrl, imagePath) {
  const validation = String.raw`
import hashlib, json, pathlib, re, sys, zipfile, xml.etree.ElementTree as ET
root=pathlib.Path(sys.argv[1]); expected,tail,url=sys.argv[2:5]; image=pathlib.Path(sys.argv[5]).read_bytes()
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main','a':'http://schemas.openxmlformats.org/drawingml/2006/main','p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
for ext in ('md','html'):
    text=(root/('exported.'+ext)).read_text()
    assert expected in text and tail in text and url in text, ext+' lost edited text, tail, or source URL'
html=(root/'exported.html').read_text()
assert '<script' not in html.lower(), 'HTML export contains executable script'
assert 'Content-Security-Policy' in html, 'HTML export lacks its restrictive CSP'
style=(root/'exported.style.md').read_text()
report={}
for ext,base,required in [('docx','word',['word/document.xml','word/styles.xml','word/_rels/document.xml.rels']),('pptx','ppt',['ppt/presentation.xml','ppt/theme/theme1.xml','ppt/slideMasters/slideMaster1.xml'])]:
    with zipfile.ZipFile(root/('exported.'+ext)) as z:
        names=z.namelist()
        assert z.testzip() is None, ext+' has a corrupt ZIP member'
        assert len(names)==len(set(names)), ext+' has duplicate ZIP names'
        for part in ['[Content_Types].xml','_rels/.rels']+required: assert part in names, ext+' missing '+part
        xml={n:ET.fromstring(z.read(n)) for n in names if n.endswith(('.xml','.rels'))}
        parts=['word/document.xml'] if ext=='docx' else [n for n in names if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)]
        assert parts, ext+' has no editable content'
        text='\n'.join(''.join(xml[n].itertext()) for n in parts)
        assert expected in text and tail in text, ext+' lost actual edited text or final paragraph'
        assert any(url in z.read(n).decode() for n in names if n.endswith('.rels')), ext+' lost clickable source relationship'
        media=[n for n in names if n.startswith(base+'/media/')]
        assert any(z.read(n)==image for n in media), ext+' lost or changed embedded PNG bytes'
        report[ext]={'xml_parts':len(xml),'content_parts':len(parts),'media_parts':len(media)}
        if ext=='pptx':
            size=xml['ppt/presentation.xml'].find('p:sldSz',ns)
            assert size is not None and size.get('cx')=='12192000' and size.get('cy')=='6858000', 'PPTX canvas is not declared 960 x 540 pt'
            for dimension in ('960','540','12,192,000','6,858,000'): assert dimension in style, 'Style guide omits actual canvas '+dimension
            fonts={node.get('typeface') for part in parts for node in xml[part].iter() if node.tag.rsplit('}',1)[-1] in ('latin','ea')}
            for face in ('Aptos','Microsoft YaHei'): assert face in fonts and face in style, 'Style guide / slide font mismatch '+face
            sizes={node.get('sz') for part in parts for node in xml[part].iter() if node.tag.rsplit('}',1)[-1]=='rPr'}
            for size in ('3200','2000','1200'): assert size in sizes and str(int(size)//100)+' pt' in style, 'Style guide / actual font size mismatch '+size
            colors={node.get('val') for node in xml['ppt/theme/theme1.xml'].findall('.//a:clrScheme//a:srgbClr',ns)}
            assert colors, 'PPTX has no theme color palette'
            for color in colors: assert color in style, 'Style guide omits actual theme color '+color
            report['pptx']['style_facts_verified']=['canvas','actual run fonts','32/20/12 pt sizes','theme palette']
print(json.dumps(report))
`;
  return JSON.parse(execFileSync('python3', ['-c', validation, directory, expectedText, tail, sourceUrl, imagePath], {encoding: 'utf8', timeout: 30000, stdio: ['ignore','pipe','pipe']}));
}

async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}${last ? ': ' + last.message : ''}`);
}

export async function runNativeSmoke() {
  assert.equal(process.platform, 'linux', 'This native WebKit harness must run on the Linux CI runner');
  const binary = resolve(process.env.WB_NATIVE_BINARY || 'src-tauri/target/debug/ai-course-workbench');
  await access(binary);
  const output = resolve(process.env.WB_NATIVE_OUTPUT || '.qa-output/native');
  const fixture = join(output, 'fixture'), exports = join(output, 'exports'), profile = join(output, 'profile');
  await Promise.all([fixture, exports, ...['config','cache','data'].map(part => join(profile, part))].map(path => mkdir(path, {recursive: true})));
  const imagePath = join(fixture, 'fixture.png');
  await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNwaDgAAAKEAYEml6crAAAAAElFTkSuQmCC', 'base64'));
  const sourcePath = join(fixture, 'native-input.md'), editedText = 'NATIVE_EDIT_SAVED_FROM_REAL_WEBVIEW', tail = 'NATIVE_FINAL_PARAGRAPH_PRESERVED';
  const sourceUrl = 'https://example.com/workbench-native-source';
  await writeFile(sourcePath, `# Native Workbench QA\n\n## First chapter\n\nNATIVE_ORIGINAL_PARAGRAPH\n\n![Fixture image](fixture.png)\n\n[Verified source](${sourceUrl})\n\n## Final chapter\n\n${tail}\n`);
  const client = new WebDriverClient(`http://127.0.0.1:${process.env.WB_WEBDRIVER_PORT || '4444'}`);
  const logs = createWriteStream(join(output, 'tauri-driver.log'));
  const driver = spawn(process.env.WB_TAURI_DRIVER || 'tauri-driver', ['--port', process.env.WB_WEBDRIVER_PORT || '4444', '--native-port', process.env.WB_NATIVE_DRIVER_PORT || '4445'], {
    stdio: ['ignore','pipe','pipe'],
    env: {...process.env, HOME: profile, XDG_CONFIG_HOME: join(profile,'config'), XDG_CACHE_HOME: join(profile,'cache'), XDG_DATA_HOME: join(profile,'data')},
  });
  driver.stdout.pipe(logs, {end:false}); driver.stderr.pipe(logs, {end:false});
  let driverError = null; driver.on('error', error => {driverError = error;});
  const steps = [], record = label => { steps.push(label); console.log('PASS', label); };
  try {
    await until(async () => {
      if (driverError) throw driverError;
      if (driver.exitCode !== null) throw new Error(`tauri-driver exited with ${driver.exitCode}`);
      return (await client.command('GET','/status'))?.ready;
    }, 'native WebDriver readiness');
    const session = await client.command('POST','/session',{capabilities:{alwaysMatch:{'tauri:options':{application:binary}},firstMatch:[{}]}});
    assert(session?.sessionId, 'Native WebDriver must create a real session'); client.session = session.sessionId;
    await client.sessionCommand('POST','/timeouts',{script:30000,implicit:0,pageLoad:30000});
    await until(()=>client.evaluate('return Boolean(globalThis.__workbenchReady && globalThis.__TAURI__?.core?.invoke && document.querySelector(".workbench"));'), 'embedded Workbench page');
    await client.evaluateAsync('await globalThis.__workbenchReady; return true;');
    await client.evaluate(`globalThis.__nativeQaErrors = [];
window.addEventListener('error', event => globalThis.__nativeQaErrors.push(String(event.message)));
window.addEventListener('unhandledrejection', event => globalThis.__nativeQaErrors.push(String(event.reason)));
return true;`);
    assert.equal(await client.evaluate('return globalThis.__workbench.bridge.native && !document.querySelector(".host-notice");'), true);
    assert.equal(await client.evaluate('return document.querySelectorAll("[data-resize]").length;'), 2);
    await client.screenshot(join(output,'01-native-empty.png'));
    record('Real embedded Tauri/WebKit starts in native mode with both sidebars; no browser mock bridge');

    await client.evaluateAsync('await globalThis.__workbench.openPath(args[0]); return true;', [sourcePath]);
    await until(()=>client.evaluate('return document.querySelector("[aria-label=\"文档标题\"]")?.value === "Native Workbench QA";'), 'native document visible in editor');
    assert.equal(await client.evaluate('return document.querySelectorAll("textarea.block-text").length >= 2;'), true);
    const opened = await client.evaluateAsync('return await globalThis.__TAURI__.core.invoke("wb_document_open",{input:{path:args[0]}});',[sourcePath]);
    await assertFileHash(sourcePath, opened.hash);
    await until(()=>client.evaluate('return Array.from(document.querySelectorAll(".document-media img")).some(img => img.alt === "Fixture image" && img.complete && img.naturalWidth > 0 && img.src.startsWith("data:image/png;base64,"));'), 'native PNG preview decoded in the actual WebView');
    await client.screenshot(join(output,'01b-native-imported-preview.png'));
    record('Production openPath loads real Markdown through Rust IPC and renders chapters plus a decoded native PNG preview');

    await client.fill('textarea.block-text', editedText);
    await client.click('[data-action="save"]');
    await until(async()=> (await readFile(sourcePath,'utf8')).includes(editedText), 'actual native save bytes');
    const savedMarkdown = await readFile(sourcePath,'utf8'); assert(savedMarkdown.includes(tail));
    assert(savedMarkdown.includes('fixture.png')); assert(savedMarkdown.includes(sourceUrl));
    await until(()=>client.evaluate('return !globalThis.__workbench.session.dirty;'), 'native save acknowledgement');
    record('Real editor input and Save control persist edited bytes, final paragraph, image and source references');

    for (const side of ['left','right']) {
      await client.click(`[data-action="collapse-${side}"]`);
      assert.equal(await client.evaluate('return document.querySelector(".workbench").classList.contains(arguments[0]);', [side+'-collapsed']), true);
      await client.click(`[data-action="expand-${side}"]`);
    }
    await client.click('[data-action="export"]');
    await until(()=>client.evaluate('return Boolean(document.querySelector("[data-form=export]"));'), 'real export panel');
    assert.deepEqual(await client.evaluate('return Array.from(document.querySelector("[data-form=export] select").options).map(x=>x.value).filter(x=>x!=="style");'), ['md','docx','pptx','html']);
    await client.click('[data-action="close-modal"]');
    assert.equal(await client.evaluate('return document.querySelector("[role=dialog]") === null;'), true);
    record('Native sidebar controls and export modal respond and dismiss without stale UI');

    const results = {};
    for (const format of ['md','html','docx','pptx']) {
      const path = join(exports,`exported.${format}`);
      const result = await client.evaluateAsync('return await globalThis.__TAURI__.core.invoke("wb_document_export",{input:args[0]});', [{path,sourcePath,format,markdown:savedMarkdown,title:'Native Workbench QA'}]);
      assert.equal(result.path,path); await assertFileHash(path,result.hash);
      for (const file of result.files || []) await access(file);
      results[format] = result;
    }
    assert.equal(await readFile(join(exports,'exported.style.md'),'utf8'), results.pptx.styleMarkdown);
    assert((await readFile(join(exports,'fixture.png'))).equals(await readFile(imagePath)), 'Portable Markdown/HTML media must retain exact bytes');
    const artifacts = validateNativeArtifacts(exports,editedText,tail,sourceUrl,imagePath);
    await writeFile(join(output,'native-export-results.json'),JSON.stringify({results,artifacts},null,2));
    await client.screenshot(join(output,'02-native-edited.png'));
    record('Actual Rust IPC exports MD/HTML/DOCX/PPTX with byte hashes, embedded PNG, clickable sources and verified portable style facts');

    const external = savedMarkdown + '\nEXTERNAL_OWNER_CHANGE\n'; await writeFile(sourcePath, external);
    await client.fill('textarea.block-text','NATIVE_UNSAVED_CHANGE'); await client.click('[data-action="save"]');
    await until(()=>client.evaluate('return document.querySelector("#save-status")?.textContent.includes("保存失败");'), 'CAS conflict surfaced by actual Save control');
    assert.equal(await readFile(sourcePath,'utf8'), external);
    assert.equal(await client.evaluate('return document.querySelector("textarea.block-text").value;'),'NATIVE_UNSAVED_CHANGE');
    await client.screenshot(join(output,'03-native-save-conflict.png'));
    // Restore this test-owned fixture to the acknowledged revision, then recover.
    await writeFile(sourcePath,savedMarkdown); await client.click('[data-action="save"]');
    await until(async()=> (await readFile(sourcePath,'utf8')).includes('NATIVE_UNSAVED_CHANGE'), 'retry after fixture conflict is resolved');
    await until(()=>client.evaluate('return !globalThis.__workbench.session.dirty;'), 'recovered save acknowledgement');
    record('External modification refuses overwrite, keeps unsaved UI text, and permits an explicit safe retry');
    assert.deepEqual(await client.evaluate('return globalThis.__nativeQaErrors;'), [], 'Native WebView raised an uncaught error');
    await writeFile(join(output,'results.json'),JSON.stringify({passed:steps.length,steps,native_bridge:true,mocked_bridge:false,external_service_calls:false,artifacts,note:'Actual Linux Tauri/WebKit UI and Rust IPC. Native system file dialogs and macOS/Windows visual UI are not exercised.'},null,2));
  } catch (error) {
    if (client.session) await client.screenshot(join(output,'failure.png')).catch(()=>{});
    await writeFile(join(output,'failure.txt'),String(error.stack || error));
    throw error;
  } finally {
    if (client.session) await client.sessionCommand('DELETE','').catch(()=>{});
    if (driver.exitCode === null) driver.kill('SIGTERM');
    await new Promise(resolve => {if(driver.exitCode !== null) return resolve(); const timer=setTimeout(()=>{driver.kill('SIGKILL');resolve();},5000);driver.once('exit',()=>{clearTimeout(timer);resolve();});});
    logs.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runNativeSmoke();
