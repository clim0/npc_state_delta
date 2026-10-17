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

test('extraction strips the tagged form, including attributes on the opening tag', () => {
    const result = extractNarrationCapture(`${STORY}\n<npc_state_delta version="1">\n${BLOCK_JSON}\n</npc_state_delta>\n`);
    assert.deepEqual(result, { text: STORY, raw: BLOCK_JSON, status: 'found' });
});

test('extraction strips a trailing ```json fence that opens with {"npcs"', () => {
    const fenced = extractNarrationCapture(`${STORY}\n\n\`\`\`json\n${BLOCK_JSON}\n\`\`\`\n  `);
    assert.deepEqual(fenced, { text: STORY, raw: BLOCK_JSON, status: 'found' });
    const bare = extractNarrationCapture(`${STORY}\n\`\`\`\n${BLOCK_JSON}\n\`\`\``);
    assert.deepEqual(bare, { text: STORY, raw: BLOCK_JSON, status: 'found' }, 'the language tag is optional');
});

test('a fence that is not trailing, or is not an npcs object, stays in the story', () => {
    const midStory = `${STORY}\n\`\`\`json\n${BLOCK_JSON}\n\`\`\`\nShe laughs afterwards.`;
    assert.equal(extractNarrationCapture(midStory).status, 'none');
    assert.equal(extractNarrationCapture(midStory).text, midStory);
    const otherJson = `${STORY}\n\`\`\`json\n{"spell":"Explosion"}\n\`\`\``;
    assert.equal(extractNarrationCapture(otherJson).status, 'none');
    assert.equal(extractNarrationCapture(otherJson).text, otherJson);
});

test('an unterminated comment or tag at the end of the text is stripped with status unterminated', () => {
    const comment = extractNarrationCapture(`${STORY}\n<!--npc_state_delta\n{"npcs":[{"name":"Yun`);
    assert.equal(comment.status, 'unterminated');
    assert.equal(comment.text, STORY);
    assert.equal(comment.raw, '{"npcs":[{"name":"Yun');
    const tagged = extractNarrationCapture(`${STORY}\n<npc_state_delta>{"npcs":[`);
    assert.equal(tagged.status, 'unterminated');
    assert.equal(tagged.text, STORY);
    assert.equal(tagged.raw, '{"npcs":[');
    assert.equal(parseNarrationCapture(comment.raw), null, 'a cut-off body never parses');
});

test('multiple blocks are all stripped and the last body is kept', () => {
    const text = `Opening line. <!--npc_state_delta {"npcs":[{"name":"First"}]} -->Middle line.\n<npc_state_delta>{"npcs":[{"name":"Second"}]}</npc_state_delta>\n\n<!--npc_state_delta\n{"npcs":[{"name":"Last"}]}\n-->\n`;
    const result = extractNarrationCapture(text);
    assert.equal(result.status, 'found');
    assert.equal(result.raw, '{"npcs":[{"name":"Last"}]}');
    assert.doesNotMatch(result.text, /npc_state_delta|First|Second|Last/);
    assert.match(result.text, /^Opening line\. Middle line\.$/);
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

test('stripUiNoise removes capture blocks before any transcript reads the message', () => {
    for (const block of [
        `<!--npc_state_delta\n${BLOCK_JSON}\n-->`,
        `<npc_state_delta>${BLOCK_JSON}</npc_state_delta>`,
        `\`\`\`json\n${BLOCK_JSON}\n\`\`\``,
        '<!--npc_state_delta {"npcs":[{"name":"Cut',
    ]) {
        const cleaned = stripUiNoise(`${STORY}\n\n${block}`);
        assert.doesNotMatch(cleaned, /npc_state_delta|"npcs"/, block);
        assert.match(cleaned, /Yunyun waves from the gate/);
    }
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
