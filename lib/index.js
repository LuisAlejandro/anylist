const EventEmitter = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {Buffer} = require('buffer');
const got = require('got');
const WebSocket = require('reconnecting-websocket');
const WS = require('ws');
const protobuf = require('protobufjs');
const FormData = require('form-data');
const definitions = require('./definitions.json');
const List = require('./list');
const Item = require('./item');
const uuid = require('./uuid');
const Recipe = require('./recipe');
const RecipeCollection = require('./recipe-collection');
const MealPlanningCalendarEvent = require('./meal-planning-calendar-event');
const MealPlanningCalendarEventLabel = require('./meal-planning-calendar-label');

const CREDENTIALS_KEY_CLIENT_ID = 'clientId';
const CREDENTIALS_KEY_ACCESS_TOKEN = 'accessToken';
const CREDENTIALS_KEY_REFRESH_TOKEN = 'refreshToken';

/**
 * AnyList class. There should be one
 * instance per account.
 * @class
 * @param {object} options account options
 * @param {string} options.email email
 * @param {string} options.password password
 * @param {string} options.credentialsFile file path for credentials storage file
 *
 * @property {List[]} lists
 * @property {Object.<string, Item[]>} recentItems
 * @property {List[]} favoriteItems
 * @property {Recipe[]} recipes
 * @fires AnyList#lists-update
 */
class AnyList extends EventEmitter {
	constructor({email, password, credentialsFile = path.join(os.homedir(), '.anylist_credentials')}) {
		super();

		this.email = email;
		this.password = password;
		this.credentialsFile = credentialsFile;

		this.authClient = got.extend({
			headers: {
				'X-AnyLeaf-API-Version': '3',
			},
			prefixUrl: 'https://www.anylist.com',
			followRedirect: false,
			hooks: {
				beforeError: [
					error => {
						const {response} = error;
						if (response && response.request) {
							const url = response.request.options.url.href;
							console.error(`Endpoint ${url} returned uncaught status code ${response.statusCode}`);
						}
						return error;
					},
				],
			},
		});

		this.client = this.authClient.extend({
			mutableDefaults: true,
			hooks: {
				beforeRequest: [
					options => {
						options.headers = {
							'X-AnyLeaf-Client-Identifier': this.clientId,
							authorization: `Bearer ${this.accessToken}`,
							...options.headers,
						};

						const path = options.url.pathname;
						if (path.startsWith('/data/')) {
							options.responseType = 'buffer';
						}
					},
				],
				afterResponse: [
					async (response, retryWithMergedOptions) => {
						if (response.statusCode !== 401) {
							return response;
						}

						const url = response.request.options.url.href;
						console.info(`Endpoint ${url} returned status code 401, refreshing access token before retrying`);

						await this._refreshTokens();
						return retryWithMergedOptions({
							headers: {
								authorization: `Bearer ${this.accessToken}`,
							},
						});
					},
				],
				beforeError: [
					error => {
						const {response} = error;
						const url = response.request.options.url.href;
						console.error(`Endpoint ${url} returned uncaught status code ${response.statusCode}`);
						return error;
					},
				],
			},
		});

		this.protobuf = protobuf.newBuilder({}).import(definitions).build('pcov.proto');

		this.lists = [];
		this.favoriteItems = [];
		this.recentItems = {};
		this.recipes = [];
		this.recipeDataId = null;
		this._userData = null;
		this.calendarId = null;
	}

	get uid() {
		if (!this.accessToken) return undefined;
		try {
			const payload = this.accessToken.split('.')[1];
			if (!payload) return undefined;
			const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
			return decoded.sub;
		} catch {
			return undefined;
		}
	}

	/**
   * Log into the AnyList account provided
   * in the constructor.
   */
	async login(connectWebSocket = true) {
		await this._loadCredentials();
		this.clientId = await this._getClientId();

		if (!this.accessToken || !this.refreshToken) {
			console.info('No saved tokens found, fetching new tokens using credentials');
			await this._fetchTokens();
		}

		if (connectWebSocket) {
			this._setupWebSocket();
		}
	}

	async _fetchTokens() {
		const form = new FormData();
		form.append('email', this.email);
		form.append('password', this.password);

		const result = await this.authClient.post('auth/token', {
			body: form,
		}).json();

		this.accessToken = result.access_token;
		this.refreshToken = result.refresh_token;
		await this._storeCredentials();
	}

	async _refreshTokens() {
		const form = new FormData();
		form.append('refresh_token', this.refreshToken);

		try {
			const result = await this.authClient.post('auth/token/refresh', {
				body: form,
			}).json();

			this.accessToken = result.access_token;
			this.refreshToken = result.refresh_token;
			await this._storeCredentials();
		} catch (error) {
			if (error.response.statusCode !== 401) {
				throw error;
			}

			console.info('Failed to refresh access token, fetching new tokens using credentials');
			await this._fetchTokens();
		}
	}

	async _getClientId() {
		if (this.clientId) {
			return this.clientId;
		}

		console.info('No saved clientId found, generating new clientId');

		const clientId = uuid();
		this.clientId = clientId;
		await this._storeCredentials();
		return clientId;
	}

	async _loadCredentials() {
		if (!this.credentialsFile) {
			return;
		}

		if (!fs.existsSync(this.credentialsFile)) {
			console.info('Credentials file does not exist, not loading saved credentials');
			return;
		}

		try {
			const encrypted = await fs.promises.readFile(this.credentialsFile);
			const credentials = this._decryptCredentials(encrypted, this.password);
			this.clientId = credentials[CREDENTIALS_KEY_CLIENT_ID];
			this.accessToken = credentials[CREDENTIALS_KEY_ACCESS_TOKEN];
			this.refreshToken = credentials[CREDENTIALS_KEY_REFRESH_TOKEN];
		} catch (error) {
			console.error(`Failed to read stored credentials: ${error.stack}`);
		}
	}

	async _storeCredentials() {
		if (!this.credentialsFile) {
			return;
		}

		const credentials = {
			[CREDENTIALS_KEY_CLIENT_ID]: this.clientId,
			[CREDENTIALS_KEY_ACCESS_TOKEN]: this.accessToken,
			[CREDENTIALS_KEY_REFRESH_TOKEN]: this.refreshToken,
		};
		try {
			const encrypted = this._encryptCredentials(credentials, this.password);
			await fs.promises.writeFile(this.credentialsFile, encrypted);
		} catch (error) {
			console.error(`Failed to write credentials to storage: ${error.stack}`);
		}
	}

	_encryptCredentials(credentials, secret) {
		const plain = JSON.stringify(credentials);
		const key = crypto.createHash('sha256').update(String(secret)).digest('base64').slice(0, 32);
		const iv = crypto.randomBytes(16);
		const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key), iv);
		let encrypted = cipher.update(plain);
		encrypted = Buffer.concat([encrypted, cipher.final()]);
		return JSON.stringify({
			iv: iv.toString('hex'),
			cipher: encrypted.toString('hex'),
		});
	}

	_decryptCredentials(credentials, secret) {
		const encrypted = JSON.parse(credentials);
		const key = crypto.createHash('sha256').update(String(secret)).digest('base64').slice(0, 32);
		const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key), Buffer.from(encrypted.iv, 'hex'));
		let plain = decipher.update(Buffer.from(encrypted.cipher, 'hex'));
		plain = Buffer.concat([plain, decipher.final()]);
		return JSON.parse(plain.toString());
	}

	_setupWebSocket() {
		AuthenticatedWebSocket.token = this.accessToken;
		AuthenticatedWebSocket.clientId = this.clientId;

		this.ws = new WebSocket('wss://www.anylist.com/data/add-user-listener', [], {
			WebSocket: AuthenticatedWebSocket,
			maxReconnectAttempts: 2,
		});

		this.ws.addEventListener('open', () => {
			console.info('Connected to websocket');
			this._heartbeatPing = setInterval(() => {
				this.ws.send('--heartbeat--');
			}, 5000); // Web app heartbeats every 5 seconds
		});

		this.ws.addEventListener('message', async ({data}) => {
			if (data === 'refresh-shopping-lists') {
				console.info('Refreshing shopping lists');

				/**
				 * Lists update event
				 * (fired when any list is modified by an outside actor).
				 * The instance's `.lists` are updated before the event fires.
				 *
				 * @event AnyList#lists-update
				 * @type {List[]} updated lists
				 */
				this.emit('lists-update', await this.getLists());
			}
		});

		// eslint-disable-next-line arrow-parens
		this.ws.addEventListener('error', async (error) => {
			console.error(`Disconnected from websocket: ${error.message}`);
			await this._refreshTokens();
			AuthenticatedWebSocket.token = this.accessToken;
		});
	}

	/**
   * Call when you're ready for your program
   * to exit.
   */
	teardown() {
		clearInterval(this._heartbeatPing);
		if (this.ws !== undefined) {
			this.ws.close();
		}
	}

	/**
   * Load all lists from account into memory.
   * @return {Promise<List[]>} lists
   */
	async getLists(refreshCache = true) {
		const decoded = await this._getUserData(refreshCache);

		this.lists = decoded.shoppingListsResponse.newLists.map(list => new List(list, this));

		for (const response of decoded.starterListsResponse.recentItemListsResponse.listResponses) {
			const list = response.starterList;
			this.recentItems[list.listId] = list.items.map(item => new Item(item, this));
		}

		const favoriteLists = decoded.starterListsResponse.favoriteItemListsResponse.listResponses.map(
			object => object.starterList,
		);

		this.favoriteItems = favoriteLists.map(
			list => new List(list, this),
		);

		return this.lists;
	}

	/**
   * Get List instance by ID.
   * @param {string} identifier list ID
   * @return {List} list
   */
	getListById(identifier) {
		return this.lists.find(l => l.identifier === identifier);
	}

	/**
   * Get List instance by name.
   * @param {string} name list name
   * @return {List} list
   */
	getListByName(name) {
		return this.lists.find(l => l.name === name);
	}

	/**
	* Get favorite items for a list.
	* @param {string} identifier list identifier
	* @return {List} favorites items array
	*/
	getFavoriteItemsByListId(identifier) {
		return this.favoriteItems.find(l => l.parentId === identifier);
	}

	/**
   * Load all meal planning calendar events from account into memory.
   * @return {Promise<MealPlanningCalendarEvent[]>} events
   */
	async getMealPlanningCalendarEvents(refreshCache = true) {
		const decoded = await this._getUserData(refreshCache);

		this.mealPlanningCalendarEvents = decoded.mealPlanningCalendarResponse.events.map(event => new MealPlanningCalendarEvent(event, this));

		// Map and assign labels
		this.mealPlanningCalendarEventLabels = decoded.mealPlanningCalendarResponse.labels.map(label => new MealPlanningCalendarEventLabel(label));
		for (const event of this.mealPlanningCalendarEvents) {
			event.label = this.mealPlanningCalendarEventLabels.find(label => label.identifier === event.labelId);
		}

		// Map and assign recipies
		this.recipes = decoded.recipeDataResponse.recipes.map(recipe => new Recipe(recipe, this));
		for (const event of this.mealPlanningCalendarEvents) {
			event.recipe = this.recipes.find(recipe => recipe.identifier === event.recipeId);
		}

		return this.mealPlanningCalendarEvents;
	}

	/**
   * Get the recently added items for a list
   * @param {string} listId list ID
   * @return {Item[]} recently added items array
   */
	getRecentItemsByListId(listId) {
		return this.recentItems[listId];
	}

	/**
   * Factory function to create new Items.
   * @param {object} item new item options
   * @return {Item} item
   */
	createItem(item) {
		return new Item(item, this);
	}

	/**
	 * Factory function to create a new MealPlanningCalendarEvent.
	 * @param {object} event new calendar event options.
	 * @return {MealPlanningCalendarEvent} event
	 */
	async createEvent(eventObject) {
		if (!this.calendarId) {
			await this._getUserData();
		}

		return new MealPlanningCalendarEvent(eventObject, this);
	}

	/**
   * Load all recipes from account into memory.
   * @return {Promise<Recipe[]>} recipes
	*/
	async getRecipes(refreshCache = true) {
		const decoded = await this._getUserData(refreshCache);

		this.recipes = decoded.recipeDataResponse.recipes.map(recipe => new Recipe(recipe, this));
		this.recipeDataId = decoded.recipeDataResponse.recipeDataId;
		return this.recipes;
	}

	/**
   * Factory function to create new Recipes.
   * @param {object} recipe new recipe options
   * @return {Recipe} recipe
   */
	async createRecipe(recipe) {
		if (!this.recipeDataId) {
			await this.getRecipes();
		}

		return new Recipe(recipe, this);
	}

	/**
   * Factory function to create new Recipe Collections.
   * @param {object} recipeCollection new recipe options
   * @return {RecipeCollection} recipe collection
   */
	createRecipeCollection(recipeCollection) {
		return new RecipeCollection(recipeCollection, this);
	}

	/**
   * Create a new shopping list.
   * @param {object} options options
   * @param {string} options.name list name (required)
   * @return {Promise<List>} the created list
   */
	async createList(options) {
		if (!options || typeof options.name !== 'string' || !options.name.trim()) {
			throw new TypeError('options.name is required and must be a non-empty string.');
		}

		await this._getUserData();

		const listId = uuid();
		const shoppingList = new this.protobuf.ShoppingList({
			identifier: listId,
			name: options.name.trim(),
			items: [],
		});

		const op = new this.protobuf.PBListOperation();
		op.setMetadata({
			operationId: uuid(),
			handlerId: 'new-shopping-list',
			userId: this.uid,
		});
		op.setList(shoppingList);

		const ops = new this.protobuf.PBListOperationList();
		ops.setOperations([op]);

		const form = new FormData();
		form.append('operations', ops.toBuffer());

		await this.client.post('data/shopping-lists/update', {
			body: form,
		});

		await this.getLists(true);
		return this.getListById(listId);
	}

	/**
   * Duplicate a list (name and items) in one request.
   * @param {List} list list to duplicate
   * @param {string} [newName] name for the copy; default list.name + ' Copy'
   * @return {Promise<List>} the created list
   */
	async duplicateList(list, newName) {
		if (list.constructor !== List) {
			throw new TypeError('Must be an instance of the List class.');
		}

		if (newName !== undefined && (typeof newName !== 'string' || !newName.trim())) {
			throw new TypeError('newName must be a non-empty string when provided.');
		}

		await this._getUserData();

		const newListId = uuid();
		const categoryMap = new Map();
		const categoryNames = new Map();
		let updatedCategoryGroup = null;
		let newGroupId = null;

		const listResponse = (this._userData.shoppingListsResponse.listResponses || [])
			.find(lr => lr.listId === list.identifier);
		if (listResponse) {
			for (const cgr of listResponse.categoryGroupResponses || []) {
				const g = cgr.categoryGroup;
				if (!g) continue;
				for (const cat of g.categories || []) {
					if (cat.name) {
						categoryNames.set(`${g.identifier}:${cat.identifier}`, String(cat.name));
					}
				}
			}
		}

		const seen = new Set();
		for (const item of list.items) {
			for (const a of item._categoryAssignments || []) {
				const key = `${a.categoryGroupId}:${a.categoryId}`;
				if (key) seen.add(key);
			}
		}

		const ordered = [...seen];
		if (ordered.length > 0) {
			newGroupId = uuid();
			const categories = ordered.map((key, i) => {
				const newCategoryId = uuid();
				categoryMap.set(key, { categoryGroupId: newGroupId, categoryId: newCategoryId });
				const name = categoryNames.get(key) || `Category ${i + 1}`;
				return new this.protobuf.PBListCategory({
					identifier: newCategoryId,
					categoryGroupId: newGroupId,
					listId: newListId,
					name,
				});
			});
			updatedCategoryGroup = new this.protobuf.PBListCategoryGroup({
				identifier: newGroupId,
				listId: newListId,
				name: 'Categories',
				categories,
			});
		}

		const itemsArray = list.items.map(item => item.encodeForCopy(uuid(), newListId, categoryMap.size > 0 ? categoryMap : undefined));

		const shoppingList = new this.protobuf.ShoppingList({
			identifier: newListId,
			name: (newName ? newName.trim() : list.name + ' Copy').trim(),
			items: itemsArray,
		});

		const shoppingListOps = [
			(() => {
				const op = new this.protobuf.PBListOperation();
				op.setMetadata({
					operationId: uuid(),
					handlerId: 'new-shopping-list',
					userId: this.uid,
				});
				op.setList(shoppingList);
				if (updatedCategoryGroup) {
					op.setUpdatedCategoryGroup(updatedCategoryGroup);
				}
				return op;
			})(),
		];

		const sourceListRaw = (this._userData.shoppingListsResponse.newLists || []).find(l => l.identifier === list.identifier);
		const allowsMultiple = sourceListRaw && sourceListRaw.allowsMultipleListCategoryGroups != null
			? Boolean(sourceListRaw.allowsMultipleListCategoryGroups)
			: Boolean(updatedCategoryGroup);
		const setAllowsOp = new this.protobuf.PBListOperation();
		setAllowsOp.setMetadata({
			operationId: uuid(),
			handlerId: 'set-allows-multiple-category-groups',
			userId: this.uid,
		});
		setAllowsOp.setListId(newListId);
		setAllowsOp.setList(new this.protobuf.ShoppingList({
			identifier: newListId,
			allowsMultipleListCategoryGroups: allowsMultiple,
		}));
		shoppingListOps.push(setAllowsOp);

		const ops = new this.protobuf.PBListOperationList();
		ops.setOperations(shoppingListOps);

		const form = new FormData();
		form.append('operations', ops.toBuffer());

		await this.client.post('data/shopping-lists/update', {
			body: form,
		});

		const sourceSettings = (this._userData.listSettingsResponse?.settings || [])
			.find(s => s.listId === list.identifier);
		if (sourceSettings) {
			const base = {
				identifier: newListId,
				userId: this.uid,
				listId: newListId,
			};
			const add = (handlerId, updatedSettings) => {
				const op = new this.protobuf.PBListSettingsOperation();
				op.setMetadata({
					operationId: uuid(),
					handlerId,
					userId: this.uid,
				});
				op.setUpdatedSettings(new this.protobuf.PBListSettings({ ...base, ...updatedSettings }));
				return op;
			};
			const settingsOps = [];
			if (sourceSettings.listThemeId != null) {
				settingsOps.push(add('set-list-theme-id', { listThemeId: sourceSettings.listThemeId }));
			}
			if (sourceSettings.shouldHideCategories != null) {
				settingsOps.push(add('set-should-hide-categories', { shouldHideCategories: sourceSettings.shouldHideCategories }));
			}
			if (sourceSettings.genericGroceryAutocompleteEnabled != null) {
				settingsOps.push(add('set-generic-grocery-autocomplete-enabled', { genericGroceryAutocompleteEnabled: sourceSettings.genericGroceryAutocompleteEnabled }));
			}
			if (sourceSettings.listItemSortOrder != null) {
				settingsOps.push(add('set-list-item-sort-order', { listItemSortOrder: sourceSettings.listItemSortOrder }));
			}
			if (newGroupId) {
				settingsOps.push(add('set-list-category-group-id', { listCategoryGroupId: newGroupId }));
			}
			if (sourceSettings.shouldRememberItemCategories != null) {
				settingsOps.push(add('set-should-remember-item-categories', { shouldRememberItemCategories: sourceSettings.shouldRememberItemCategories }));
			}
			if (sourceSettings.favoritesAutocompleteEnabled != null) {
				settingsOps.push(add('set-favorites-autocomplete-enabled', { favoritesAutocompleteEnabled: sourceSettings.favoritesAutocompleteEnabled }));
			}
			if (sourceSettings.recentItemsAutocompleteEnabled != null) {
				settingsOps.push(add('set-recent-items-autocomplete-enabled', { recentItemsAutocompleteEnabled: sourceSettings.recentItemsAutocompleteEnabled }));
			}
			if (sourceSettings.shouldHideCompletedItems != null) {
				settingsOps.push(add('set-should-hide-completed-items', { shouldHideCompletedItems: sourceSettings.shouldHideCompletedItems }));
			}
			if (sourceSettings.icon && (sourceSettings.icon.iconName || sourceSettings.icon.tintHexColor)) {
				const icon = new this.protobuf.PBIcon({
					iconName: sourceSettings.icon.iconName || 'default_list_icon',
					tintHexColor: sourceSettings.icon.tintHexColor,
				});
				settingsOps.push(add('set-icon', { icon }));
			}
			if (sourceSettings.badgeMode != null) {
				settingsOps.push(add('set-badge-mode', { badgeMode: sourceSettings.badgeMode }));
			}
			if (sourceSettings.shouldHideStoreNames != null) {
				settingsOps.push(add('set-should-hide-store-names', { shouldHideStoreNames: sourceSettings.shouldHideStoreNames }));
			}
			if (sourceSettings.shouldHidePrices != null) {
				settingsOps.push(add('set-should-hide-prices', { shouldHidePrices: sourceSettings.shouldHidePrices }));
			}
			if (sourceSettings.shouldHideRunningTotals != null) {
				settingsOps.push(add('set-should-hide-running-total-bar', { shouldHideRunningTotals: sourceSettings.shouldHideRunningTotals }));
			}
			if (sourceSettings.leftRunningTotalType != null) {
				settingsOps.push(add('set-left-running-total-type', { leftRunningTotalType: sourceSettings.leftRunningTotalType }));
			}
			if (sourceSettings.rightRunningTotalType != null) {
				settingsOps.push(add('set-right-running-total-type', { rightRunningTotalType: sourceSettings.rightRunningTotalType }));
			}
			if (settingsOps.length > 0) {
				const settingsOpList = new this.protobuf.PBListSettingsOperationList();
				settingsOpList.setOperations(settingsOps);
				const settingsForm = new FormData();
				settingsForm.append('operations', settingsOpList.toBuffer());
				await this.client.post('data/list-settings/update', { body: settingsForm });
			}
		}

		if (listResponse) {
			const updateV2Ops = [];
			const storeIdMap = new Map();
			for (const store of listResponse.stores || []) {
				const newStoreId = uuid();
				storeIdMap.set(store.identifier, newStoreId);
				const storeOp = new this.protobuf.PBListOperation();
				storeOp.setMetadata({
					operationId: uuid(),
					handlerId: 'new-store',
					userId: this.uid,
				});
				storeOp.setListId(newListId);
				storeOp.setUpdatedStore(new this.protobuf.PBStore({
					identifier: newStoreId,
					listId: newListId,
					name: store.name,
					sortIndex: store.sortIndex,
				}));
				updateV2Ops.push(storeOp);
			}
			for (const filter of listResponse.storeFilters || []) {
				const newFilterId = uuid();
				const mappedStoreIds = (filter.storeIds || []).map(sid => storeIdMap.get(sid)).filter(Boolean);
				const filterOp = new this.protobuf.PBListOperation();
				filterOp.setMetadata({
					operationId: uuid(),
					handlerId: 'new-store-filter',
					userId: this.uid,
				});
				filterOp.setListId(newListId);
				const filterPayload = {
					identifier: newFilterId,
					listId: newListId,
					name: filter.name,
					storeIds: mappedStoreIds,
					includesUnassignedItems: filter.includesUnassignedItems,
					sortIndex: filter.sortIndex,
					showsAllItems: filter.showsAllItems,
				};
				if (newGroupId) filterPayload.listCategoryGroupId = newGroupId;
				filterOp.setUpdatedStoreFilter(new this.protobuf.PBStoreFilter(filterPayload));
				updateV2Ops.push(filterOp);
			}
			const rules = (listResponse.categorizationRules || []).filter(rule => {
				const key = `${rule.categoryGroupId}:${rule.categoryId}`;
				return categoryMap.has(key);
			});
			const RULES_BATCH = 25;
			for (let i = 0; i < rules.length; i += RULES_BATCH) {
				const batch = rules.slice(i, i + RULES_BATCH).map(rule => {
					const key = `${rule.categoryGroupId}:${rule.categoryId}`;
					const mapped = categoryMap.get(key);
					if (!mapped) return null;
					return new this.protobuf.PBListCategorizationRule({
						identifier: uuid(),
						listId: newListId,
						categoryGroupId: mapped.categoryGroupId,
						itemName: rule.itemName,
						categoryId: mapped.categoryId,
					});
				}).filter(Boolean);
				if (batch.length === 0) continue;
				const rulesOp = new this.protobuf.PBListOperation();
				rulesOp.setMetadata({
					operationId: uuid(),
					handlerId: 'bulk-save-categorization-rules',
					userId: this.uid,
				});
				rulesOp.setListId(newListId);
				rulesOp.setUpdatedCategorizationRules(batch);
				updateV2Ops.push(rulesOp);
			}
			if (updateV2Ops.length > 0) {
				const updateV2OpList = new this.protobuf.PBListOperationList();
				updateV2OpList.setOperations(updateV2Ops);
				const updateV2Form = new FormData();
				updateV2Form.append('operations', updateV2OpList.toBuffer());
				await this.client.post('data/shopping-lists/update-v2', { body: updateV2Form });
			}
		}

		const foldersResp = this._userData.listFoldersResponse;
		if (foldersResp && foldersResp.rootFolderId) {
			const rootFolder = (foldersResp.listFolders || []).find(f => f.identifier === foldersResp.rootFolderId);
			const currentItems = (rootFolder && rootFolder.items) ? [...rootFolder.items] : [];
			const newFirst = new this.protobuf.PBListFolderItem({
				identifier: newListId,
				itemType: 0, // ListType
			});
			const rest = currentItems.filter(it => it.identifier !== newListId);
			const folderItems = [newFirst, ...rest.map(it => new this.protobuf.PBListFolderItem({
				identifier: it.identifier,
				itemType: it.itemType != null ? it.itemType : 0,
			}))];
			const folderOp = new this.protobuf.PBListFolderOperation();
			folderOp.setMetadata({
				operationId: uuid(),
				handlerId: 'set-ordered-folder-items',
				userId: this.uid,
			});
			folderOp.setListDataId(foldersResp.rootFolderId);
			folderOp.setOriginalParentFolderId(foldersResp.rootFolderId);
			folderOp.setFolderItems(folderItems);
			const folderOpList = new this.protobuf.PBListFolderOperationList();
			folderOpList.setOperations([folderOp]);
			const folderForm = new FormData();
			folderForm.append('operations', folderOpList.toBuffer());
			await this.client.post('data/list-folders/update', { body: folderForm });
		}

		await this.getLists(true);
		return this.getListById(newListId);
	}

	async _getUserData(refreshCache) {
		if (!this._userData || refreshCache) {
			const result = await this.client.post('data/user-data/get');
			this._userData = this.protobuf.PBUserDataResponse.decode(result.body);
			this.calendarId = this._userData.mealPlanningCalendarResponse.calendarId;
		}

		return this._userData;
	}

}

class AuthenticatedWebSocket extends WS {
	static token;
	static clientId;

	constructor(url, protocols) {
		super(url, protocols, {
			headers: {
				authorization: `Bearer ${AuthenticatedWebSocket.token}`,
				'x-anyleaf-client-identifier': AuthenticatedWebSocket.clientId,
				'X-AnyLeaf-API-Version': '3',
			},
		});
	}
}

module.exports = AnyList;
