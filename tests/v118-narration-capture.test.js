import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildNarrationCapturePrompt,
    buildScannerPrompt,
    extractNarrationCapture,
    parseNarrationCapture,
    stripUiNoise,
} from '../core.js';

// One-pass narration capture: the roleplay reply ends with a hidden quick-scan block that the
// extension strips before anything reads the message and merges instead of a scanner request.
const BLOCK_JSON = '{"npcs":[{"name":"Yunyun","present":true}]}';
const STORY = 'Yunyun waves from the gate and calls Kazuma over.';

test('extraction strips the comment form and keeps its body as raw', () => {
    const result = extractNarrationCapture(`${STORY}\n\n<!--npc_state_delta\n${BLOCK_JSON}\n-->`);
    assert.deepEqual(result, { text: STORY, raw: BLOCK_JSON, status: 'found' });
});

test('the tagged form is stripped only in lenient mode', () => {
    const text = `${STORY}\n<npc_state_delta version="1">\n${BLOCK_JSON}\n</npc_state_delta>\n`;
    assert.deepEqual(extractNarrationCapture(text, { lenient: true }), { text: STORY, raw: BLOCK_JSON, status: 'found' });
    assert.deepEqual(extractNarrationCapture(text), { text, raw: '', status: 'none' }, 'strict mode leaves the tag form untouched');
});

test('a trailing ```json fence that opens with {"npcs" is stripped only in lenient mode', () => {
    const fencedText = `${STORY}\n\n\`\`\`json\n${BLOCK_JSON}\n\`\`\`\n  `;
    assert.deepEqual(extractNarrationCapture(fencedText, { lenient: true }), { text: STORY, raw: BLOCK_JSON, status: 'found' });
    assert.deepEqual(extractNarrationCapture(fencedText), { text: fencedText, raw: '', status: 'none' }, 'strict mode leaves a fence untouched');
    const bare = extractNarrationCapture(`${STORY}\n\`\`\`\n${BLOCK_JSON}\n\`\`\``, { lenient: true });
    assert.deepEqual(bare, { text: STORY, raw: BLOCK_JSON, status: 'found' }, 'the language tag is optional');
});

test('a fence that is not trailing, or is not an npcs object, stays in the story', () => {
    const midStory = `${STORY}\n\`\`\`json\n${BLOCK_JSON}\n\`\`\`\nShe laughs afterwards.`;
    assert.equal(extractNarrationCapture(midStory, { lenient: true }).status, 'none');
    assert.equal(extractNarrationCapture(midStory, { lenient: true }).text, midStory);
    const otherJson = `${STORY}\n\`\`\`json\n{"spell":"Explosion"}\n\`\`\``;
    assert.equal(extractNarrationCapture(otherJson, { lenient: true }).status, 'none');
    assert.equal(extractNarrationCapture(otherJson, { lenient: true }).text, otherJson);
});

test('the fence body never crosses another fence', () => {
    const crossing = 'Story A.\n```json\n{"npcs":[]}\n```\nStory B\n```\nStatus\n```';
    assert.deepEqual(extractNarrationCapture(crossing, { lenient: true }), { text: crossing, raw: '', status: 'none' }, 'story B and the status block survive');
    const earlierCode = 'Story.\n```\ncode\n```\nMore.\n```json\n{"npcs":[]}\n```';
    const result = extractNarrationCapture(earlierCode, { lenient: true });
    assert.equal(result.status, 'found');
    assert.equal(result.raw, '{"npcs":[]}');
    assert.equal(result.text, 'Story.\n```\ncode\n```\nMore.', 'only the trailing npcs fence is removed');
});

test('a closing --> at the very end wins over a --> inside the JSON', () => {
    const json = '{"npcs":[{"name":"Yunyun","goal":"A --> B"}]}';
    const result = extractNarrationCapture(`${STORY} <!--npc_state_delta\n${json}\n-->\n`);
    assert.deepEqual(result, { text: STORY, raw: json, status: 'found' }, 'nothing of the block leaks into the story');
    assert.equal(parseNarrationCapture(result.raw).npcs[0].goal, 'A --> B');
    const twoBlocks = extractNarrationCapture(`A <!--npc_state_delta {"npcs":[1]} --> B <!--npc_state_delta ${json} -->`);
    assert.equal(twoBlocks.raw, json, 'the last block keeps its inner arrow');
    assert.doesNotMatch(twoBlocks.text, /npc_state_delta|-->|npcs/);
});

test('an unterminated comment at the end is stripped in both modes; an unterminated tag only when lenient', () => {
    const commentText = `${STORY}\n<!--npc_state_delta\n{"npcs":[{"name":"Yun`;
    for (const lenient of [false, true]) {
        const comment = extractNarrationCapture(commentText, { lenient });
        assert.equal(comment.status, 'unterminated');
        assert.equal(comment.text, STORY);
        assert.equal(comment.raw, '{"npcs":[{"name":"Yun');
        assert.equal(parseNarrationCapture(comment.raw), null, 'a cut-off body never parses');
    }
    const taggedText = `${STORY}\n<npc_state_delta>{"npcs":[`;
    const tagged = extractNarrationCapture(taggedText, { lenient: true });
    assert.equal(tagged.status, 'unterminated');
    assert.equal(tagged.text, STORY);
    assert.equal(tagged.raw, '{"npcs":[');
    assert.equal(extractNarrationCapture(taggedText).status, 'none');
    assert.equal(extractNarrationCapture(taggedText).text, taggedText);
});

test('multiple comment blocks are all stripped and the last body is kept', () => {
    const text = 'Opening line. <!--npc_state_delta {"npcs":[{"name":"First"}]} -->Middle line.\n\n<!--npc_state_delta\n{"npcs":[{"name":"Last"}]}\n-->\n';
    for (const lenient of [false, true]) {
        const result = extractNarrationCapture(text, { lenient });
        assert.equal(result.status, 'found');
        assert.equal(result.raw, '{"npcs":[{"name":"Last"}]}');
        assert.equal(result.text, 'Opening line. Middle line.');
    }
    const mixed = extractNarrationCapture('A <!--npc_state_delta {"npcs":[1]} --> B <npc_state_delta>{"npcs":[2]}</npc_state_delta> C <!--npc_state_delta {"npcs":[3]} -->', { lenient: true });
    assert.equal(mixed.raw, '{"npcs":[3]}');
    assert.doesNotMatch(mixed.text, /npc_state_delta|npcs/);
    const strictMixed = extractNarrationCapture('A <!--npc_state_delta {"npcs":[1]} --> B <npc_state_delta>{"npcs":[2]}</npc_state_delta>');
    assert.equal(strictMixed.raw, '{"npcs":[1]}');
    assert.equal(strictMixed.text, 'A  B <npc_state_delta>{"npcs":[2]}</npc_state_delta>', 'strict mode removes only the comment');
});

test('text without a block is returned unchanged, including trailing whitespace', () => {
    const plain = `${STORY}\n\n   `;
    const result = extractNarrationCapture(plain);
    assert.equal(result.status, 'none');
    assert.equal(result.raw, '');
    assert.equal(result.text, plain, 'the same string comes back; whitespace is trimmed only when a block was removed');
    assert.deepEqual(extractNarrationCapture(undefined), { text: '', raw: '', status: 'none' });
    assert.deepEqual(extractNarrationCapture(null), { text: '', raw: '', status: 'none' });
    // Leading whitespace survives even when a block is removed; only the tail is trimmed.
    assert.equal(extractNarrationCapture(`  ${STORY} <!--npc_state_delta {"npcs":[]} -->\n\n`).text, `  ${STORY}`);
});

test('parseNarrationCapture returns the parsed object or null', () => {
    assert.deepEqual(parseNarrationCapture(BLOCK_JSON), JSON.parse(BLOCK_JSON));
    assert.equal(parseNarrationCapture(''), null);
    assert.equal(parseNarrationCapture('   \n'), null);
    assert.equal(parseNarrationCapture(undefined), null);
    assert.equal(parseNarrationCapture('{"npcs": [ {"name": '), null, 'malformed JSON is null, not an exception');
    assert.equal(parseNarrationCapture('not json at all, just prose'), null);
    assert.equal(parseNarrationCapture('42'), null, 'a non-object value is null');
    assert.equal(parseNarrationCapture('"just a string"'), null);
});

test('stripUiNoise removes comment blocks (strict) before any transcript reads the message', () => {
    for (const block of [
        `<!--npc_state_delta\n${BLOCK_JSON}\n-->`,
        '<!--npc_state_delta {"npcs":[{"name":"Cut',
        '<!--npc_state_delta {"npcs":[{"goal":"A --> B"}]} -->',
    ]) {
        const cleaned = stripUiNoise(`${STORY}\n\n${block}`);
        assert.doesNotMatch(cleaned, /npc_state_delta|"npcs"|-->/, block);
        assert.match(cleaned, /Yunyun waves from the gate/);
    }
    // The lenient near-miss forms are not capture syntax for the transcript reader.
    assert.match(stripUiNoise(`${STORY}\n\`\`\`json\n${BLOCK_JSON}\n\`\`\``), /"npcs"/);
});

const TRANSCRIPT = 'Kazuma: Who is that at the gate?\nMegumin: Yunyun waves from the gate, clutching her wand.';
const promptOptions = (extra = {}) => ({
    transcript: TRANSCRIPT,
    existingNpcs: [],
    candidates: [],
    userName: 'Kazuma',
    charName: 'Megumin',
    maxNpcs: 12,
    admissionMode: 'conservative',
    ...extra,
});

function rulesSection(prompt) {
    const start = prompt.indexOf('\nAdmission:');
    const end = prompt.indexOf('Identity index (matching only):');
    assert.ok(start > 0 && end > start, 'prompt keeps its admission/rules/identity layout');
    return prompt.slice(start, end);
}

test('the scanner prompt is unchanged when narrationCapture is absent or false', () => {
    for (const extra of [{}, { fullScanMode: true, currentTranscript: TRANSCRIPT }, { customFieldNames: ['Favorite food'] }]) {
        const absent = buildScannerPrompt(promptOptions(extra));
        const explicitFalse = buildScannerPrompt(promptOptions({ ...extra, narrationCapture: false }));
        assert.equal(absent, explicitFalse);
        assert.ok(absent.startsWith('Private NPC dossier scanner.\n'));
        assert.ok(absent.includes(`Story context:\n${TRANSCRIPT}`), 'the transcript section is still supplied to the scanner');
        assert.doesNotMatch(absent, /ONE-PASS CAPTURE|<!--npc_state_delta|the chat above/);
    }
});

test('the capture prompt carries the scanner rules without the transcript and ends with the reminder', () => {
    const scanner = buildScannerPrompt(promptOptions());
    const capture = buildNarrationCapturePrompt(promptOptions());
    assert.ok(capture.startsWith('NPC STATE DELTA ONE-PASS CAPTURE.'));
    assert.ok(capture.includes('<!--npc_state_delta'));
    assert.ok(capture.includes('Identity index (matching only):'));
    assert.equal(rulesSection(capture), rulesSection(scanner), 'Rules 1-15 and the admission policy are the scanner\'s own text');
    for (let rule = 1; rule <= 15; rule += 1) assert.match(capture, new RegExp(`\\n${rule}\\. `), `rule ${rule}`);
    assert.ok(!capture.includes(TRANSCRIPT), 'the roleplay model already sees the chat; no transcript is duplicated');
    assert.ok(!capture.includes('Yunyun waves from the gate'));
    assert.ok(!capture.includes('Story context:\n'));
    assert.match(capture, /Story context: the chat above\./);
    assert.ok(capture.endsWith('\n\nReminder: after the story, end with the <!--npc_state_delta {valid JSON} --> block.'));
    assert.ok(!capture.startsWith('Private NPC dossier scanner.'));
});

test('the capture prompt is never a full-window prompt and keeps the custom-field rule', () => {
    const forcedFull = buildNarrationCapturePrompt(promptOptions({ fullScanMode: true, currentTranscript: TRANSCRIPT }));
    assert.equal(forcedFull, buildNarrationCapturePrompt(promptOptions()), 'fullScanMode is overridden to false');
    assert.doesNotMatch(forcedFull, /FULL-WINDOW RECONCILIATION|CURRENT exchange \(authoritative/);
    const withFields = buildNarrationCapturePrompt(promptOptions({ customFieldNames: ['Favorite food'] }));
    const scannerWithFields = buildScannerPrompt(promptOptions({ customFieldNames: ['Favorite food'] }));
    const rule = scannerWithFields.slice(scannerWithFields.indexOf('CUSTOM FIELDS (Favorite food)'));
    assert.ok(rule.length > 20 && rule.startsWith('CUSTOM FIELDS (Favorite food)'));
    assert.ok(withFields.includes(rule), 'the custom-field rule is appended to the capture prompt too');
    assert.ok(withFields.indexOf(rule) < withFields.indexOf('Reminder: after the story'), 'the reminder stays last');
    assert.ok(!buildNarrationCapturePrompt(promptOptions()).includes('CUSTOM FIELDS'));
});
