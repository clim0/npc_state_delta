import test from 'node:test';
import assert from 'node:assert/strict';

import { createNpcRecord, mergeScanResult } from '../core.js';

const KESSGATE_CONTEXT = 'In Kessgate, the innkeeper of the Drowned Rat, a bald man, pours ale.';

function maelisRecord(overrides = {}) {
    return {
        ...createNpcRecord('Maelis Varn'),
        id: 'npc_maelis',
        aliases: ['Innkeeper'],
        role: 'Innkeeper of the Heron',
        homeBase: 'The Heron, Port Vell',
        ...overrides,
    };
}

function kessgateInnkeeper(overrides = {}) {
    return {
        name: 'Innkeeper',
        identityKind: 'role_label',
        dossierSignal: 'persistent',
        role: 'innkeeper of the Drowned Rat',
        present: true,
        location: 'Drowned Rat, Kessgate',
        ...overrides,
    };
}

function mergeRow(npcs, row, options = {}) {
    return mergeScanResult({ npcs, candidates: [], turn: 5 }, { npcs: [row] },
        { turn: 5, developmentContext: KESSGATE_CONTEXT, ...options });
}

test('a shared role alias alone does not merge a different person into a named dossier', () => {
    const maelis = maelisRecord();
    const result = mergeRow([maelis], kessgateInnkeeper());

    const kept = result.state.npcs.find(npc => npc.id === 'npc_maelis');
    assert.equal(kept.role, 'Innkeeper of the Heron');
    assert.equal(kept.homeBase, 'The Heron, Port Vell');
    assert.equal(kept.location, maelis.location);
    assert.equal(kept.present, false);
    assert.ok(!result.report.updated.includes('npc_maelis'), 'Maelis must not be reported as updated');

    const separate = [
        ...result.state.npcs.filter(npc => npc.id !== 'npc_maelis'),
        ...result.state.candidates,
    ];
    assert.equal(separate.length, 1, 'the Kessgate innkeeper becomes its own candidate or dossier');
    assert.equal(separate[0].name, 'Innkeeper');
    assert.match(separate[0].location, /Kessgate/);
});

test('a shared role alias still merges with sameIndividual, presence or an overlapping place', () => {
    const cases = [
        ['sameIndividual', [maelisRecord()], kessgateInnkeeper({ sameIndividual: true })],
        ['present', [maelisRecord({ present: true })], kessgateInnkeeper()],
        ['location', [maelisRecord()], kessgateInnkeeper({ location: 'Common room of the Heron', role: '' })],
        ['home base', [maelisRecord({ homeBase: 'Drowned Rat, Kessgate' })], kessgateInnkeeper()],
    ];
    for (const [label, npcs, row] of cases) {
        const result = mergeRow(npcs, row);
        assert.equal(result.state.npcs.length, 1, `${label}: no separate dossier`);
        assert.equal(result.state.candidates.length, 0, `${label}: no separate candidate`);
        assert.ok(result.report.updated.includes('npc_maelis'), `${label}: Maelis receives the row`);
        assert.equal(result.state.npcs[0].name, 'Maelis Varn');
    }
});

test('a real nickname alias and an id match still merge without continuity evidence', () => {
    const red = mergeRow([maelisRecord({ aliases: ['Red'] })],
        { name: 'Red', identityKind: 'proper_name', present: true, location: 'Drowned Rat, Kessgate' });
    assert.equal(red.state.npcs.length, 1);
    assert.ok(red.report.updated.includes('npc_maelis'));

    const byId = mergeRow([maelisRecord()], kessgateInnkeeper({ id: 'npc_maelis' }));
    assert.equal(byId.state.npcs.length, 1);
    assert.equal(byId.state.candidates.length, 0);
    assert.ok(byId.report.updated.includes('npc_maelis'));
});

test('an interim dossier named by its role still matches the role label and promotes on a name reveal', () => {
    const interim = { ...createNpcRecord('Innkeeper'), id: 'npc_innkeeper', manual: false, role: 'innkeeper of the Drowned Rat' };

    const sameLabel = mergeRow([interim], kessgateInnkeeper({ present: false, location: '' }));
    assert.equal(sameLabel.state.npcs.length, 1);
    assert.equal(sameLabel.state.candidates.length, 0);
    assert.ok(sameLabel.report.updated.includes('npc_innkeeper'));

    const revealed = mergeRow([interim], {
        name: 'Tobin Hale', aliases: ['Innkeeper'], identityKind: 'proper_name', present: true,
        location: 'Drowned Rat, Kessgate',
    }, { developmentContext: 'The innkeeper of the Drowned Rat, Tobin Hale, pours ale.' });
    assert.equal(revealed.state.npcs.length, 1, 'the reveal must not create a duplicate dossier');
    assert.equal(revealed.state.npcs[0].id, 'npc_innkeeper');
    assert.equal(revealed.state.npcs[0].name, 'Tobin Hale');
    assert.ok(revealed.state.npcs[0].aliases.includes('Innkeeper'));
    assert.deepEqual(revealed.report.renamed, [{ id: 'npc_innkeeper', from: 'Innkeeper', to: 'Tobin Hale' }]);
});
