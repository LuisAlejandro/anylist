const FormData = require('form-data');
const uuid = require('./uuid');

const OP_MAPPING = {
	name: 'set-list-item-name',
	quantity: 'set-list-item-quantity',
	details: 'set-list-item-details',
	checked: 'set-list-item-checked',
	categoryMatchId: 'set-list-item-category-match-id',
	manualSortIndex: 'set-list-item-sort-order',
};

/**
 * Item class.
 * @class
 *
 * @param {object} item item
 * @param {object} context context
 *
 * @property {string} listId
 * @property {string} identifier
 * @property {string} name
 * @property {string} details
 * @property {string} quantity
 * @property {string} checked
 * @property {string} manualSortIndex
 * @property {string} userId
 * @property {string} categoryMatchId
 * @property {string[]} storeIds
 * @property {object[]} prices
 * @property {object} packageSize
 */
class Item {
	/**
   * @hideconstructor
   */
	static _quantityFromRaw(i) {
		if (i.quantity != null && i.quantity !== '') return String(i.quantity);
		if (i.deprecatedQuantity != null && i.deprecatedQuantity !== '') return String(i.deprecatedQuantity);
		const q = i.quantityPb;
		if (q && (q.rawQuantity != null && q.rawQuantity !== '')) return String(q.rawQuantity);
		if (q && (q.amount != null || q.unit)) {
			const amount = q.amount != null && q.amount !== '' ? String(q.amount) : '';
			const unit = q.unit != null && q.unit !== '' ? String(q.unit) : '';
			return [amount, unit].filter(Boolean).join(' ').trim() || undefined;
		}
		return undefined;
	}

	constructor(i, {client, protobuf, uid}) {
		this._listId = i.listId;
		this._identifier = i.identifier || uuid();
		this._name = i.name;
		this._details = i.details;
		this._quantity = Item._quantityFromRaw(i);
		this._checked = i.checked;
		this._manualSortIndex = i.manualSortIndex;
		this._userId = i.userId;
		this._categoryMatchId = i.categoryMatchId || 'other';

		this._storeIds = Array.isArray(i.storeIds) ? [...i.storeIds] : [];
		this._previousStoreIds = Array.isArray(i.storeIds) ? [...i.storeIds] : [];
		this._prices = (i.prices || []).map(p => ({
			amount: p.amount,
			details: p.details,
			storeId: p.storeId,
			date: p.date,
		}));
		this._packageSizePb = i.packageSizePb ? {
			size: i.packageSizePb.size,
			unit: i.packageSizePb.unit,
			packageType: i.packageSizePb.packageType,
			rawPackageSize: i.packageSizePb.rawPackageSize,
		} : undefined;

		this._client = client;
		this._protobuf = protobuf;
		this._uid = uid;

		this._fieldsToUpdate = [];
	}

	toJSON() {
		return {
			listId: this._listId,
			identifier: this._identifier,
			name: this._name,
			details: this._details,
			quantity: this._quantity,
			checked: this._checked,
			manualSortIndex: this._manualSortIndex,
			userId: this._userId,
			categoryMatchId: this._categoryMatchId,
			storeIds: [...this._storeIds],
			prices: this._prices.map(p => ({...p})),
			packageSize: this._packageSizePb ? {...this._packageSizePb} : undefined,
		};
	}

	_encode() {
		const listItem = {
			identifier: this._identifier,
			listId: this._listId,
			name: this._name,
			quantity: this._quantity,
			details: this._details,
			checked: this._checked,
			category: this._category,
			userId: this._userId,
			categoryMatchId: this._categoryMatchId,
			manualSortIndex: this._manualSortIndex,
		};
		if (this._storeIds.length > 0) {
			listItem.storeIds = this._storeIds;
		}
		if (this._prices.length > 0) {
			listItem.prices = this._prices.map(p => new this._protobuf.PBItemPrice(p));
		}
		if (this._packageSizePb) {
			listItem.packageSizePb = new this._protobuf.PBItemPackageSize(this._packageSizePb);
		}
		return new this._protobuf.ListItem(listItem);
	}

	/**
	 * Encode this item as a ListItem for a duplicate list (new identifier and listId).
	 * @param {string} newIdentifier new item id
	 * @param {string} newListId new list id
	 * @return {object} ListItem protobuf message
	 */
	encodeForCopy(newIdentifier, newListId) {
		const listItem = {
			identifier: newIdentifier,
			listId: newListId,
			name: this._name,
			quantity: this._quantity,
			details: this._details,
			checked: this._checked,
			category: this._category,
			userId: this._userId,
			categoryMatchId: this._categoryMatchId,
			manualSortIndex: this._manualSortIndex,
		};
		if (this._storeIds.length > 0) {
			listItem.storeIds = this._storeIds;
		}
		if (this._prices.length > 0) {
			listItem.prices = this._prices.map(p => new this._protobuf.PBItemPrice(p));
		}
		if (this._packageSizePb) {
			listItem.packageSizePb = new this._protobuf.PBItemPackageSize(this._packageSizePb);
		}
		return new this._protobuf.ListItem(listItem);
	}

	get identifier() {
		return this._identifier;
	}

	set identifier(_) {
		throw new Error('You cannot update an item ID.');
	}

	get listId() {
		return this._listId;
	}

	set listId(l) {
		if (this._listId === undefined) {
			this._listId = l;
			this._fieldsToUpdate.push('listId');
		} else {
			throw new Error('You cannot move items between lists.');
		}
	}

	get name() {
		return this._name;
	}

	set name(n) {
		this._name = n;
		this._fieldsToUpdate.push('name');
	}

	get quantity() {
		return this._quantity;
	}

	set quantity(q) {
		if (typeof q === 'number') {
			q = q.toString();
		}

		this._quantity = q;
		this._fieldsToUpdate.push('quantity');
	}

	get details() {
		return this._details;
	}

	set details(d) {
		this._details = d;
		this._fieldsToUpdate.push('details');
	}

	get checked() {
		return this._checked;
	}

	set checked(c) {
		if (typeof c !== 'boolean') {
			throw new TypeError('Checked must be a boolean.');
		}

		this._checked = c;
		this._fieldsToUpdate.push('checked');
	}

	get userId() {
		return this._userId;
	}

	set userId(_) {
		throw new Error('Cannot set user ID of an item after creation.');
	}

	get categoryMatchId() {
		return this._categoryMatchId;
	}

	set categoryMatchId(i) {
		this._categoryMatchId = i;
		this._fieldsToUpdate.push('categoryMatchId');
	}

	get manualSortIndex() {
		return this._manualSortIndex;
	}

	set manualSortIndex(i) {
		if (typeof i !== 'number') {
			throw new TypeError('Sort index must be a number.');
		}

		this._manualSortIndex = i;
		this._fieldsToUpdate.push('manualSortIndex');
	}

	get storeIds() {
		return [...this._storeIds];
	}

	set storeIds(ids) {
		if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
			throw new TypeError('storeIds must be an array of strings.');
		}
		this._storeIds = [...ids];
		if (!this._fieldsToUpdate.includes('storeIds')) {
			this._fieldsToUpdate.push('storeIds');
		}
	}

	get prices() {
		return this._prices.map(p => ({...p}));
	}

	set prices(arr) {
		if (!Array.isArray(arr)) {
			throw new TypeError('prices must be an array.');
		}
		this._prices = arr.map(p => ({
			amount: p.amount,
			details: p.details,
			storeId: p.storeId,
			date: p.date,
		}));
		if (!this._fieldsToUpdate.includes('prices')) {
			this._fieldsToUpdate.push('prices');
		}
	}

	get packageSize() {
		return this._packageSizePb ? {...this._packageSizePb} : undefined;
	}

	set packageSize(obj) {
		if (obj === undefined || obj === null) {
			this._packageSizePb = undefined;
		} else {
			this._packageSizePb = {
				size: obj.size,
				unit: obj.unit,
				packageType: obj.packageType,
				rawPackageSize: obj.rawPackageSize,
			};
		}
		if (!this._fieldsToUpdate.includes('packageSize')) {
			this._fieldsToUpdate.push('packageSize');
		}
	}

	/**
   * Save local changes to item to
   * AnyList's API.
   * Must set `isFavorite=true` if editing "favorites" list
   * @param {boolean} [isFavorite=false]
   * @return {Promise}
   */
	async save(isFavorite = false) {
		const allOps = [];
		const simpleFields = this._fieldsToUpdate.filter(f => OP_MAPPING[f]);

		for (const field of simpleFields) {
			const value = this[field];
			const opName = OP_MAPPING[field];
			const op = new this._protobuf.PBListOperation();
			op.setMetadata({
				operationId: uuid(),
				handlerId: opName,
				userId: this._uid,
			});
			op.setListId(this._listId);
			op.setListItemId(this._identifier);
			if (typeof value === 'boolean') {
				op.setUpdatedValue(value === true ? 'y' : 'n');
			} else {
				op.setUpdatedValue(value.toString());
			}
			allOps.push(op);
		}

		if (this._fieldsToUpdate.includes('packageSize')) {
			const op = new this._protobuf.PBListOperation();
			op.setMetadata({
				operationId: uuid(),
				handlerId: 'set-list-item-package-size',
				userId: this._uid,
			});
			op.setListId(this._listId);
			op.setListItemId(this._identifier);
			op.setListItem(this._encode());
			allOps.push(op);
		}

		if (this._fieldsToUpdate.includes('prices')) {
			for (const p of this._prices) {
				const op = new this._protobuf.PBListOperation();
				op.setMetadata({
					operationId: uuid(),
					handlerId: 'save-item-price',
					userId: this._uid,
				});
				op.setListId(this._listId);
				op.setListItemId(this._identifier);
				op.setItemPrice(new this._protobuf.PBItemPrice(p));
				allOps.push(op);
			}
		}

		if (this._fieldsToUpdate.includes('storeIds')) {
			const added = this._storeIds.filter(id => !this._previousStoreIds.includes(id));
			const removed = this._previousStoreIds.filter(id => !this._storeIds.includes(id));
			for (const storeId of added) {
				const op = new this._protobuf.PBListOperation();
				op.setMetadata({
					operationId: uuid(),
					handlerId: 'add-list-item-store-id',
					userId: this._uid,
				});
				op.setListId(this._listId);
				op.setListItemId(this._identifier);
				op.setUpdatedValue(storeId);
				allOps.push(op);
			}
			for (const storeId of removed) {
				const op = new this._protobuf.PBListOperation();
				op.setMetadata({
					operationId: uuid(),
					handlerId: 'remove-list-item-store-id',
					userId: this._uid,
				});
				op.setListId(this._listId);
				op.setListItemId(this._identifier);
				op.setUpdatedValue(storeId);
				allOps.push(op);
			}
			this._previousStoreIds = [...this._storeIds];
		}

		if (allOps.length === 0) {
			return;
		}

		const opList = new this._protobuf.PBListOperationList();
		opList.setOperations(allOps);

		const form = new FormData();
		form.append('operations', opList.toBuffer());

		await this._client.post(isFavorite ? 'data/starter-lists/update' : 'data/shopping-lists/update', {
			body: form,
		});

		this._fieldsToUpdate = [];
	}
}

module.exports = Item;
