#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const protobuf = require('protobufjs');
const definitions = require('../lib/definitions.json');

const pb = protobuf.newBuilder({}).import(definitions).build('pcov.proto');

function extractOperationsFromMultipart(multipartBase64) {
	const buf = Buffer.from(multipartBase64, 'base64');
	const nameIdx = buf.indexOf(Buffer.from('name="operations"', 'utf8'));
	if (nameIdx < 0) return null;
	const doubleNewline = buf.indexOf(Buffer.from('\r\n\r\n', 'utf8'), nameIdx);
	if (doubleNewline < 0) return null;
	const start = doubleNewline + 4;
	const endBoundary = buf.indexOf(Buffer.from('\r\n--', 'utf8'), start);
	const end = endBoundary < 0 ? buf.length : endBoundary;
	return buf.slice(start, end);
}

function listHandlerIds(buf) {
	const ops = pb.PBListOperationList.decode(buf);
	const ids = [];
	for (let i = 0; i < ops.operations.length; i++) {
		const op = ops.operations[i];
		const meta = op.metadata;
		const handlerId = meta && meta.handlerId ? meta.handlerId : '(no metadata)';
		ids.push(handlerId);
	}
	return ids;
}

function describeOp(op) {
	const meta = op.metadata || {};
	const out = { handlerId: meta.handlerId };
	if (op.listId) out.listId = op.listId;
	if (op.listItemId) out.listItemId = op.listItemId;
	if (op.listItem) out.hasListItem = true;
	if (op.list) out.hasList = true;
	if (op.updatedCategoryGroup) out.hasUpdatedCategoryGroup = true;
	if (op.updatedCategory) out.hasUpdatedCategory = true;
	if (op.updatedCategorizationRules && op.updatedCategorizationRules.length) out.categorizationRulesCount = op.updatedCategorizationRules.length;
	if (op.updatedValue !== undefined) out.updatedValue = String(op.updatedValue).slice(0, 60);
	return out;
}

const harPath = process.argv[2] || path.join(__dirname, '../har.json');
const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
const fullFlow = process.argv.includes('--flow');

const dataPostEntries = [];
for (const entry of har.log.entries) {
	const url = entry.request.url || '';
	const method = entry.request.method || '';
	if (method !== 'POST' || !url.includes('anylist.com/data/')) continue;
	const pd = entry.request.postData;
	const started = entry.startedDateTime || '';
	dataPostEntries.push({ url, started, postData: pd, entry });
}

if (fullFlow) {
	dataPostEntries.sort((a, b) => (a.started < b.started ? -1 : 1));
	console.log('=== FULL FLOW (chronological) ===\n');
	for (const { url, started, postData } of dataPostEntries) {
		const path = url.replace('https://www.anylist.com', '');
		let summary = path;
		if (postData && postData.text) {
			const opsBuf = extractOperationsFromMultipart(postData.text);
			if (opsBuf && opsBuf.length > 0) {
				try {
					const opList = pb.PBListOperationList.decode(opsBuf);
					const ids = [...new Set(opList.operations.map(o => (o.metadata && o.metadata.handlerId) || '?'))];
					summary += '\n  ' + ids.join(', ');
				} catch (_) {
					if (path.includes('root_folder') || path.includes('logical_timestamp') || path.includes('list-folders')) {
						summary += '\n  (binary/timestamps)';
					}
				}
			}
		}
		console.log(started, summary + '\n');
	}
	process.exit(0);
}

for (const entry of har.log.entries) {
	const url = entry.request.url || '';
	const method = entry.request.method || '';
	if (method !== 'POST') continue;
	const pd = entry.request.postData;
	if (!pd || !pd.text) continue;

	const isShoppingUpdate = url.includes('shopping-lists/update') && !url.includes('update-v2');
	const isListSettings = url.includes('list-settings/update');
	const isUpdateV2 = url.includes('shopping-lists/update-v2');

	if (!isShoppingUpdate && !isListSettings && !isUpdateV2) continue;

	const opsBuf = extractOperationsFromMultipart(pd.text);
	if (!opsBuf || opsBuf.length === 0) continue;

	try {
		const opList = pb.PBListOperationList.decode(opsBuf);
		const ops = opList.operations;
		const handlerIds = ops.map(op => (op.metadata && op.metadata.handlerId) || '(no metadata)');
		const unique = [...new Set(handlerIds)];
		console.log('\n' + url);
		console.log('  bodySize:', pd.text.length, 'opsBuf:', opsBuf.length, 'operations:', ops.length);
		console.log('  handlerIds:', unique.join(', '));
		if (ops.length <= 20) {
			ops.forEach((op, i) => {
				console.log('    ', i + 1, describeOp(op));
			});
		} else if (handlerIds.some(h => h.includes('duplicate-list-bulk') || h.includes('bulk-add'))) {
			console.log('  First 3 ops:');
			ops.slice(0, 3).forEach((op, i) => console.log('    ', i + 1, describeOp(op)));
			const firstNewList = ops[0];
			if (firstNewList.list) {
				const list = firstNewList.list;
				console.log('  new-shopping-list.list: identifier=%s name=%s itemsCount=%s', list.identifier, list.name, (list.items || []).length);
				if (firstNewList.updatedCategoryGroup) {
					const g = firstNewList.updatedCategoryGroup;
					console.log('  new-shopping-list.updatedCategoryGroup: identifier=%s listId=%s name=%s categoriesCount=%s', g.identifier, g.listId, g.name, (g.categories || []).length);
					if (g.categories && g.categories[0]) console.log('    first category:', g.categories[0].identifier, g.categories[0].name);
				}
			}
			const firstBulk = ops[1];
			if (firstBulk && firstBulk.list) {
				const list = firstBulk.list;
				console.log('  duplicate-list-bulk-add op[2].list: identifier=%s itemsCount=%s', list.identifier, (list.items || []).length);
				if (list.items && list.items[0]) {
					const it = list.items[0];
					console.log('    first item: name=%s categoryAssignments=%s', it.name, (it.categoryAssignments || []).length);
				}
			}
			console.log('  ... last op:', describeOp(ops[ops.length - 1]));
		}
	} catch (e) {
		console.log('\n' + url, 'decode error:', e.message);
	}
}
