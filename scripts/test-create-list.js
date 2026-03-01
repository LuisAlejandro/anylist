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

	const listName = `Test list ${Date.now()}`;
	const any = new AnyList({email, password});

	try {
		await any.login(false);
	} catch (err) {
		console.error('Login failed:', err.message);
		process.exit(1);
	}

	let created;
	try {
		created = await any.createList({name: listName});
		console.log('createList() returned:', created ? {identifier: created.identifier, name: created.name} : created);
	} catch (err) {
		console.error('createList failed:', err.message);
		if (err.response) console.error('response status:', err.response.statusCode, 'body:', err.response.body?.slice(0, 200));
		any.teardown();
		process.exit(1);
	}

	await any.getLists(true);
	console.log('lists count after getLists:', any.lists.length);
	const found = any.getListByName(listName);

	if (found && found.identifier === created.identifier) {
		console.log('OK: List created and found in getLists. identifier=%s name=%s', found.identifier, found.name);
	} else {
		console.error('FAIL: List not found after create. created=%s found=%s', created?.identifier, found?.identifier);
		any.teardown();
		process.exit(1);
	}

	any.teardown();
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
