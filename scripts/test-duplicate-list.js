#!/usr/bin/env node
'use strict';

require('dotenv').config();
const AnyList = require('../lib/index.js');

async function main() {
	const email = process.env.ANYLIST_EMAIL;
	const password = process.env.ANYLIST_PASSWORD;
	if (!email || !password) {
		console.error('Set ANYLIST_EMAIL and ANYLIST_PASSWORD in .env');
		process.exit(1);
	}

	const any = new AnyList({email, password});

	try {
		await any.login(false);
	} catch (err) {
		console.error('Login failed:', err.message);
		process.exit(1);
	}

	await any.getLists(true);
	if (any.lists.length === 0) {
		console.error('No lists to duplicate. Create a list first.');
		any.teardown();
		process.exit(1);
	}

	const listNameArg = process.argv[2];
	const sourceList = listNameArg
		? any.lists.find(l => l.name && l.name.toLowerCase().includes(listNameArg.toLowerCase()))
		: any.lists[0];
	if (!sourceList) {
		console.error('No list matching "%s". Available:', listNameArg);
		any.lists.slice(0, 10).forEach(l => console.error('  -', l.name));
		any.teardown();
		process.exit(1);
	}
	console.log('Duplicating list: %s (%s)', sourceList.name, sourceList.identifier);
	const copyName = `Copy of ${sourceList.name} ${Date.now()}`;

	let duplicated;
	try {
		duplicated = await any.duplicateList(sourceList, copyName);
		console.log('duplicateList() returned:', duplicated ? {identifier: duplicated.identifier, name: duplicated.name} : duplicated);
	} catch (err) {
		console.error('duplicateList failed:', err.message);
		if (err.response) console.error('response status:', err.response.statusCode, 'body:', err.response.body?.slice(0, 200));
		any.teardown();
		process.exit(1);
	}

	const found = any.getListByName(copyName);

	if (found && found.identifier === duplicated.identifier && found.identifier !== sourceList.identifier) {
		console.log('OK: List duplicated and found. source=%s copy=%s name=%s', sourceList.identifier, found.identifier, found.name);
	} else {
		console.error('FAIL: Duplicate not found or same id. duplicated=%s found=%s', duplicated?.identifier, found?.identifier);
		any.teardown();
		process.exit(1);
	}

	any.teardown();
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
