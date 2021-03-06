/**
 * @license Copyright (c) 2003-2018, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

/**
 * @module widget/widget
 */

import Plugin from '@ckeditor/ckeditor5-core/src/plugin';
import MouseObserver from '@ckeditor/ckeditor5-engine/src/view/observer/mouseobserver';
import { getLabel, isWidget, WIDGET_SELECTED_CLASS_NAME } from './utils';
import { getCode, keyCodes, parseKeystroke } from '@ckeditor/ckeditor5-utils/src/keyboard';

import '../theme/widget.css';

const selectAllKeystrokeCode = parseKeystroke( 'Ctrl+A' );

/**
 * The widget plugin. It enables base support for widgets.
 *
 * See {@glink api/widget package page} for more details and documentation.
 *
 * This plugin enables multiple behaiors required by the widgets:
 *
 * * The model to view selection converter for the editing pipeline (it handles widget custom selection rendering).
 * If a converted selection is wraps around a widget element, that selection is marked as
 * {@link module:engine/view/selection~Selection#isFake fake}. Additionally, proper the `ck-widget_selected` CSS class
 * is added to indicate that widget has been selected.
 * * The mouse and keyboard events handling on and around widget elements.
 *
 * @extends module:core/plugin~Plugin.
 */
export default class Widget extends Plugin {
	/**
	 * @inheritDoc
	 */
	static get pluginName() {
		return 'Widget';
	}

	/**
	 * @inheritDoc
	 */
	init() {
		const view = this.editor.editing.view;
		const viewDocument = view.document;

		/**
		 * Holds previously selected widgets.
		 *
		 * @private
		 * @type {Set.<module:engine/view/element~Element>}
		 */
		this._previouslySelected = new Set();

		// Model to view selection converter.
		// Converts selection placed over widget element to fake selection
		this.editor.editing.downcastDispatcher.on( 'selection', ( evt, data, conversionApi ) => {
			// Remove selected class from previously selected widgets.
			this._clearPreviouslySelectedWidgets( conversionApi.writer );

			const viewWriter = conversionApi.writer;
			const viewSelection = viewWriter.document.selection;
			const selectedElement = viewSelection.getSelectedElement();
			let lastMarked = null;

			for ( const range of viewSelection.getRanges() ) {
				for ( const value of range ) {
					const node = value.item;

					// Do not mark nested widgets in selected one. See: #57.
					if ( isWidget( node ) && !isChild( node, lastMarked ) ) {
						viewWriter.addClass( WIDGET_SELECTED_CLASS_NAME, node );

						this._previouslySelected.add( node );
						lastMarked = node;

						// Check if widget is a single element selected.
						if ( node == selectedElement ) {
							viewWriter.setSelection( viewSelection.getRanges(), { fake: true, label: getLabel( selectedElement ) } );
						}
					}
				}
			}
		}, { priority: 'low' } );

		// If mouse down is pressed on widget - create selection over whole widget.
		view.addObserver( MouseObserver );
		this.listenTo( viewDocument, 'mousedown', ( ...args ) => this._onMousedown( ...args ) );

		// Handle custom keydown behaviour.
		this.listenTo( viewDocument, 'keydown', ( ...args ) => this._onKeydown( ...args ), { priority: 'high' } );

		// Handle custom delete behaviour.
		this.listenTo( viewDocument, 'delete', ( evt, data ) => {
			if ( this._handleDelete( data.direction == 'forward' ) ) {
				data.preventDefault();
				evt.stop();
			}
		}, { priority: 'high' } );
	}

	/**
	 * Handles {@link module:engine/view/document~Document#event:mousedown mousedown} events on widget elements.
	 *
	 * @private
	 * @param {module:utils/eventinfo~EventInfo} eventInfo
	 * @param {module:engine/view/observer/domeventdata~DomEventData} domEventData
	 */
	_onMousedown( eventInfo, domEventData ) {
		const editor = this.editor;
		const view = editor.editing.view;
		const viewDocument = view.document;
		let element = domEventData.target;

		// Do nothing if inside nested editable.
		if ( isInsideNestedEditable( element ) ) {
			return;
		}

		// If target is not a widget element - check if one of the ancestors is.
		if ( !isWidget( element ) ) {
			element = element.findAncestor( isWidget );

			if ( !element ) {
				return;
			}
		}

		domEventData.preventDefault();

		// Focus editor if is not focused already.
		if ( !viewDocument.isFocused ) {
			view.focus();
		}

		// Create model selection over widget.
		const modelElement = editor.editing.mapper.toModelElement( element );

		this._setSelectionOverElement( modelElement );
	}

	/**
	 * Handles {@link module:engine/view/document~Document#event:keydown keydown} events.
	 *
	 * @private
	 * @param {module:utils/eventinfo~EventInfo} eventInfo
	 * @param {module:engine/view/observer/domeventdata~DomEventData} domEventData
	 */
	_onKeydown( eventInfo, domEventData ) {
		const keyCode = domEventData.keyCode;
		const isForward = keyCode == keyCodes.delete || keyCode == keyCodes.arrowdown || keyCode == keyCodes.arrowright;
		let wasHandled = false;

		// Checks if the keys were handled and then prevents the default event behaviour and stops
		// the propagation.
		if ( isArrowKeyCode( keyCode ) ) {
			wasHandled = this._handleArrowKeys( isForward );
		} else if ( isSelectAllKeyCode( domEventData ) ) {
			wasHandled = this._selectAllNestedEditableContent() || this._selectAllContent();
		} else if ( keyCode === keyCodes.enter ) {
			wasHandled = this._handleEnterKey( domEventData.shiftKey );
		}

		if ( wasHandled ) {
			domEventData.preventDefault();
			eventInfo.stop();
		}
	}

	/**
	 * Handles delete keys: backspace and delete.
	 *
	 * @private
	 * @param {Boolean} isForward Set to true if delete was performed in forward direction.
	 * @returns {Boolean|undefined} Returns `true` if keys were handled correctly.
	 */
	_handleDelete( isForward ) {
		// Do nothing when the read only mode is enabled.
		if ( this.editor.isReadOnly ) {
			return;
		}

		const modelDocument = this.editor.model.document;
		const modelSelection = modelDocument.selection;

		// Do nothing on non-collapsed selection.
		if ( !modelSelection.isCollapsed ) {
			return;
		}

		const objectElement = this._getObjectElementNextToSelection( isForward );

		if ( objectElement ) {
			this.editor.model.change( writer => {
				let previousNode = modelSelection.anchor.parent;

				// Remove previous element if empty.
				while ( previousNode.isEmpty ) {
					const nodeToRemove = previousNode;
					previousNode = nodeToRemove.parent;

					writer.remove( nodeToRemove );
				}

				this._setSelectionOverElement( objectElement );
			} );

			return true;
		}
	}

	/**
	 * Handles arrow keys.
	 *
	 * @private
	 * @param {Boolean} isForward Set to true if arrow key should be handled in forward direction.
	 * @returns {Boolean|undefined} Returns `true` if keys were handled correctly.
	 */
	_handleArrowKeys( isForward ) {
		const model = this.editor.model;
		const schema = model.schema;
		const modelDocument = model.document;
		const modelSelection = modelDocument.selection;
		const objectElement = modelSelection.getSelectedElement();

		// If object element is selected.
		if ( objectElement && schema.isObject( objectElement ) ) {
			const position = isForward ? modelSelection.getLastPosition() : modelSelection.getFirstPosition();
			const newRange = schema.getNearestSelectionRange( position, isForward ? 'forward' : 'backward' );

			if ( newRange ) {
				model.change( writer => {
					writer.setSelection( newRange );
				} );
			}

			return true;
		}

		// If selection is next to object element.
		// Return if not collapsed.
		if ( !modelSelection.isCollapsed ) {
			return;
		}

		const objectElement2 = this._getObjectElementNextToSelection( isForward );

		if ( !!objectElement2 && schema.isObject( objectElement2 ) ) {
			this._setSelectionOverElement( objectElement2 );

			return true;
		}
	}

	/**
	 * Handles the enter key, giving users and access to positions in the editable directly before
	 * (<kbd>Shift</kbd>+<kbd>Enter</kbd>) or after (<kbd>Enter</kbd>) the selected widget.
	 * It improves the UX, mainly when the widget is the first or last child of the root editable
	 * and there's no other way to type after or before it.
	 *
	 * @private
	 * @param {Boolean} isBackwards Set to true if the new paragraph is to be inserted before
	 * the selected widget (<kbd>Shift</kbd>+<kbd>Enter</kbd>).
	 * @returns {Boolean|undefined} Returns `true` if keys were handled correctly.
	 */
	_handleEnterKey( isBackwards ) {
		const model = this.editor.model;
		const modelSelection = model.document.selection;
		const objectElement = modelSelection.getSelectedElement();

		if ( objectElement && model.schema.isObject( objectElement ) ) {
			model.change( writer => {
				const paragraph = writer.createElement( 'paragraph' );

				writer.insert( paragraph, objectElement, isBackwards ? 'before' : 'after' );
				writer.setSelection( paragraph, 'in' );
			} );

			return true;
		}
	}

	/**
	 * Extends the {@link module:engine/model/selection~Selection document's selection} to span the entire
	 * content of the nested editable if already anchored in one.
	 *
	 * See: {@link module:engine/model/schema~Schema#getLimitElement}.
	 *
	 * @private
	 */
	_selectAllNestedEditableContent() {
		const model = this.editor.model;
		const documentSelection = model.document.selection;
		const limitElement = model.schema.getLimitElement( documentSelection );

		if ( documentSelection.getFirstRange().root == limitElement ) {
			return false;
		}

		model.change( writer => {
			writer.setSelection( writer.createRangeIn( limitElement ) );
		} );

		return true;
	}

	/**
	 * Handles <kbd>CTRL + A</kbd> when widget is selected.
	 *
	 * @private
	 * @returns {Boolean} Returns true if widget was selected and selecting all was handled by this method.
	 */
	_selectAllContent() {
		const model = this.editor.model;
		const editing = this.editor.editing;
		const view = editing.view;
		const viewDocument = view.document;
		const viewSelection = viewDocument.selection;

		const selectedElement = viewSelection.getSelectedElement();

		// Only widget is selected.
		// https://github.com/ckeditor/ckeditor5-widget/issues/23
		if ( selectedElement && isWidget( selectedElement ) ) {
			const widgetParent = editing.mapper.toModelElement( selectedElement.parent );

			model.change( writer => {
				writer.setSelection( writer.createRangeIn( widgetParent ) );
			} );

			return true;
		}

		return false;
	}

	/**
	 * Sets {@link module:engine/model/selection~Selection document's selection} over given element.
	 *
	 * @private
	 * @param {module:engine/model/element~Element} element
	 */
	_setSelectionOverElement( element ) {
		this.editor.model.change( writer => {
			writer.setSelection( writer.createRangeOn( element ) );
		} );
	}

	/**
	 * Checks if {@link module:engine/model/element~Element element} placed next to the current
	 * {@link module:engine/model/selection~Selection model selection} exists and is marked in
	 * {@link module:engine/model/schema~Schema schema} as `object`.
	 *
	 * @private
	 * @param {Boolean} forward Direction of checking.
	 * @returns {module:engine/model/element~Element|null}
	 */
	_getObjectElementNextToSelection( forward ) {
		const model = this.editor.model;
		const schema = model.schema;
		const modelSelection = model.document.selection;

		// Clone current selection to use it as a probe. We must leave default selection as it is so it can return
		// to its current state after undo.
		const probe = model.createSelection( modelSelection );
		model.modifySelection( probe, { direction: forward ? 'forward' : 'backward' } );
		const objectElement = forward ? probe.focus.nodeBefore : probe.focus.nodeAfter;

		if ( !!objectElement && schema.isObject( objectElement ) ) {
			return objectElement;
		}

		return null;
	}

	/**
	 * Removes CSS class from previously selected widgets.
	 *
	 * @private
	 * @param {module:engine/view/downcastwriter~DowncastWriter} writer
	 */
	_clearPreviouslySelectedWidgets( writer ) {
		for ( const widget of this._previouslySelected ) {
			writer.removeClass( WIDGET_SELECTED_CLASS_NAME, widget );
		}

		this._previouslySelected.clear();
	}
}

// Returns 'true' if provided key code represents one of the arrow keys.
//
// @param {Number} keyCode
// @returns {Boolean}
function isArrowKeyCode( keyCode ) {
	return keyCode == keyCodes.arrowright ||
		keyCode == keyCodes.arrowleft ||
		keyCode == keyCodes.arrowup ||
		keyCode == keyCodes.arrowdown;
}

// Returns 'true' if provided (DOM) key event data corresponds with the Ctrl+A keystroke.
//
// @param {module:engine/view/observer/keyobserver~KeyEventData} domEventData
// @returns {Boolean}
function isSelectAllKeyCode( domEventData ) {
	return getCode( domEventData ) == selectAllKeystrokeCode;
}

// Returns `true` when element is a nested editable or is placed inside one.
//
// @param {module:engine/view/element~Element}
// @returns {Boolean}
function isInsideNestedEditable( element ) {
	while ( element ) {
		if ( element.is( 'editableElement' ) && !element.is( 'rootElement' ) ) {
			return true;
		}

		// Click on nested widget should select it.
		if ( isWidget( element ) ) {
			return false;
		}

		element = element.parent;
	}

	return false;
}

// Checks whether the specified `element` is a child of the `parent` element.
//
// @param {module:engine/view/element~Element} element An element to check.
// @param {module:engine/view/element~Element|null} parent A parent for the element.
// @returns {Boolean}
function isChild( element, parent ) {
	if ( !parent ) {
		return false;
	}

	return Array.from( element.getAncestors() ).includes( parent );
}
