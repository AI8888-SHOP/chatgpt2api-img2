// Execute the real serializers and selector handlers without any upstream calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
function load(file, imports) {
  const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } });
  const sandbox = { exports: {}, FormData, URLSearchParams, require(name) {
    if (name in imports) return imports[name];
    throw new Error('Unexpected import: ' + name);
  }};
  vm.runInNewContext(output.outputText, sandbox);
  return sandbox.exports;
}
const calls = [];
const api = load('lib/api.ts', { '@/lib/request': { httpRequest: async (...args) => { calls.push(args); return {}; } } });
test('image generation JSON and edit multipart retain portrait/landscape/4K size and GIF', async () => {
  for (const size of ['2048x1152', '1152x2048', '4096x4096', 'auto']) {
    await api.createImageGenerationJob('test', 'gpt-image-2.6', {size, output_format:'gif'});
    const [url, request] = calls.at(-1);
    assert.equal(url, '/v1/image-jobs/generations');
    assert.equal(request.body.size, size);
    assert.equal(request.body.output_format, 'gif');
    await api.createImageEditJob([new Blob(['reference'], {type:'image/png'})], 'test', 'gpt-image-2.6', {size, output_format:'gif', client_image_id:'one'});
    const [editUrl, edit] = calls.at(-1);
    assert.equal(editUrl, '/v1/image-jobs/edits');
    assert.equal(edit.body.get('size'), size);
    assert.equal(edit.body.get('output_format'), 'gif');
    assert.equal(edit.body.getAll('size').length, 1);
    assert.equal(edit.body.get('client_image_id'), 'one');
    for (const field of ['width','height','resolution','aspect_ratio']) assert.equal(edit.body.has(field), false);
  }
});
test('video UI API preserves 16:9, 10s, 1080p with reference and stable client ID', async () => {
  const payload = {model:'grok-imagine-video-1.5', duration:10, resolution:'1080p', aspect_ratio:'16:9', mode:'image', reference_images:[{asset_id:'a'.repeat(32)}], client_request_id:'test-stable-client-id'};
  await api.createVideoJob(payload);
  assert.equal(calls.at(-1)[0], '/v1/videos/generations');
  assert.deepEqual(calls.at(-1)[1].body, payload);
});
const jsx = (type, props) => ({type, props});
const sizes = load('lib/image-sizes.ts', {});
let effects = [];
const selector = load('app/image/components/size-selector.tsx', {
  'react': {useEffect:fn => effects.push(fn), useState:value => [value, () => {}]},
  'react/jsx-runtime': {jsx, jsxs:jsx}, 'lucide-react': {Crop:'Crop'},
  '@/lib/image-sizes': sizes,
  '@/components/ui/button': {Button:'Button'}, '@/components/ui/input': {Input:'Input'},
  '@/components/ui/select': Object.fromEntries(['Select','SelectContent','SelectItem','SelectTrigger','SelectValue'].map(v => [v,v])),
});
function elements(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return [tree, ...elements(tree.props?.children)];
}
function select(props) {
  effects = [];
  const tree = selector.AspectRatioSelect(props);
  return { tree, select:elements(tree).find(item => item.type === 'Select'), items:elements(tree).filter(item => item.type === 'SelectItem') };
}
test('unverified presets are not advertised; custom dimensions retain exact Select values', () => {
  assert.equal(sizes.IMAGE_SIZE_PRESETS.length, 21);
  assert.equal(new Set(sizes.IMAGE_SIZE_PRESETS.map(item => item.value)).size, 21);
  for (const preset of sizes.IMAGE_SIZE_PRESETS) {
    const view = select({value:preset.value, model:'gpt-image-2.6', onChange:() => {}});
    assert.equal(view.select.props.value, preset.value);
    assert.equal(view.items.filter(item => item.props.value === preset.value).length, 1);
    assert.match(view.items.find(item => item.props.value === preset.value).props.children.join(''), /自定义/);
  }
  for (const model of ['gpt-image-2.6', 'unknown', 'nano-banana-2.1']) {
    assert.equal(sizes.imageSizeOptions(model).length, 0);
    const view = select({value:'auto', model, onChange:() => {}});
    assert.equal(view.items.length, 2); // auto + explicit custom request
  }
});
test('actual selector sends exact dimensions; model switches clear restricted invalid values, never downscale', () => {
  let selected;
  const view = select({value:'auto', model:'gpt-image-2.6', onChange:value => selected=value});
  view.select.props.onValueChange('2048x1152');
  assert.equal(selected, '2048x1152');
  view.select.props.onValueChange('1152x2048');
  assert.equal(selected, '1152x2048');
  const grok = select({value:'auto', model:'grok-imagine-image', onChange:value => selected=value});
  grok.select.props.onValueChange('1280x720');
  assert.equal(selected, '1280x720');
  for (const model of ['grok-imagine-image-2.0', 'nano-banana-2.1', 'unknown']) {
    const unknown = select({value:'4096x2304', model, onChange:value => selected=value});
    assert.equal(unknown.select.props.value, '4096x2304');
    effects.forEach(fn => fn());
    assert.equal(selected, '1280x720');
  }
  const restricted = select({value:'4096x2304', model:'grok-imagine-image', onChange:value => selected=value});
  assert.equal(restricted.select.props.value, '');
  effects.forEach(fn => fn());
  assert.equal(selected, '');
});
test('unknown models preserve custom request sizes and synchronous edit also sends them', async () => {
  const custom = select({value:'3840x2160', model:'nano-banana-Pro', onChange:() => {}});
  assert.equal(custom.select.props.value, '3840x2160');
  assert.equal(custom.items.filter(item => item.props.value === '3840x2160').length, 1);
  assert.equal(sizes.validImageSize('3840x2160'), true);
  for (const value of ['', '-1x100', '0x100', '20x', '10x20x30', '999999x1']) assert.equal(sizes.validImageSize(value), false);
  await api.editImage([new Blob(['ref'], {type:'image/png'})], 'test', 'gpt-image-2.6', {size:'3840x2160', output_format:'gif'});
  const [url, request] = calls.at(-1);
  assert.equal(url, '/v1/images/edits');
  assert.equal(request.body.get('size'), '3840x2160');
  assert.equal(request.body.get('output_format'), 'gif');
});
