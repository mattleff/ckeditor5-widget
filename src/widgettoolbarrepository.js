/**
 * @license Copyright (c) 2003-2018, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

/**
 * @module widget/widgettoolbarrepository
 */

import Plugin from '@ckeditor/ckeditor5-core/src/plugin';
import ContextualBalloon from '@ckeditor/ckeditor5-ui/src/panel/balloon/contextualballoon';
import ToolbarView from '@ckeditor/ckeditor5-ui/src/toolbar/toolbarview';
import BalloonPanelView from '@ckeditor/ckeditor5-ui/src/panel/balloon/balloonpanelview';
import { isWidget } from './utils';
import CKEditorError from '@ckeditor/ckeditor5-utils/src/ckeditorerror';

/**
 * Widget toolbar repository plugin. A central point for registering widget toolbars. This plugin handles the whole
 * toolbar rendering process and exposes a concise API.
 *
 * To add a toolbar for your widget use the {@link ~WidgetToolbarRepository#register `WidgetToolbarRepository#register()`} method.
 *
 * The following example comes from the {@link module:image/imagetoolbar~ImageToolbar} plugin:
 *
 * 		class ImageToolbar extends Plugin {
 *			static get requires() {
 *				return [ WidgetToolbarRepository ];
 *			}
 *
 *			afterInit() {
 *				const editor = this.editor;
 *				const widgetToolbarRepository = editor.plugins.get( WidgetToolbarRepository );
 *
 *				widgetToolbarRepository.register( 'image', {
 *					items: editor.config.get( 'image.toolbar' ),
 *					getRelatedElement: getSelectedImageWidget
 *				} );
 *			}
 *		}
 */
export default class WidgetToolbarRepository extends Plugin {
	/**
	 * @inheritDoc
	 */
	static get requires() {
		return [ ContextualBalloon ];
	}

	/**
	 * @inheritDoc
	 */
	static get pluginName() {
		return 'WidgetToolbarRepository';
	}

	/**
	 * @inheritDoc
	 */
	init() {
		const editor = this.editor;

		// Disables the default balloon toolbar for all widgets.
		if ( editor.plugins.has( 'BalloonToolbar' ) ) {
			const balloonToolbar = editor.plugins.get( 'BalloonToolbar' );

			this.listenTo( balloonToolbar, 'show', evt => {
				if ( isWidgetSelected( editor.editing.view.document.selection ) ) {
					evt.stop();
				}
			}, { priority: 'high' } );
		}

		/**
		 * A map of toolbar definitions.
		 *
		 * @protected
		 * @member {Map.<String,module:widget/widgettoolbarrepository~WidgetRepositoryToolbarDefinition>} #_toolbarDefinitions
		 */
		this._toolbarDefinitions = new Map();

		/**
		 * @private
		 */
		this._balloon = this.editor.plugins.get( 'ContextualBalloon' );

		this.listenTo( editor.ui, 'update', () => {
			this._updateToolbarsVisibility();
		} );

		// UI#update is not fired after focus is back in editor, we need to check if balloon panel should be visible.
		this.listenTo( editor.ui.focusTracker, 'change:isFocused', () => {
			this._updateToolbarsVisibility();
		}, { priority: 'low' } );
	}

	destroy() {
		super.destroy();

		for ( const toolbarConfig of this._toolbarDefinitions.values() ) {
			toolbarConfig.view.destroy();
		}
	}

	/**
	 * Registers toolbar in the WidgetToolbarRepository. It renders it in the `ContextualBalloon` based on the value of the invoked
	 * `getRelatedElement` function. Toolbar items are gathered from `items` array.
	 * The balloon's CSS class is by default `ck-toolbar-container` and may be override with the `balloonClassName` option.
	 *
	 * Note: This method should be called in the {@link module:core/plugin~PluginInterface#afterInit `Plugin#afterInit()`}
	 * callback (or later) to make sure that the given toolbar items were already registered by other plugins.
	 *
	 * @param {String} toolbarId An id for the toolbar. Used to
	 * @param {Object} options
	 * @param {Array.<String>} options.items Array of toolbar items.
	 * @param {Function} options.getRelatedElement Callback which returns an element the toolbar should be attached to.
	 * @param {String} [options.balloonClassName='ck-toolbar-container'] CSS class for the widget balloon.
	 */
	register( toolbarId, { items, getRelatedElement, balloonClassName = 'ck-toolbar-container' } ) {
		const editor = this.editor;
		const toolbarView = new ToolbarView();

		if ( this._toolbarDefinitions.has( toolbarId ) ) {
			/**
			 * Toolbar with the given id was already added.
			 *
			 * @error widget-toolbar-duplicated
			 * @param toolbarId Toolbar id.
			 */
			throw new CKEditorError( 'widget-toolbar-duplicated: Toolbar with the given id was already added.', { toolbarId } );
		}

		toolbarView.fillFromConfig( items, editor.ui.componentFactory );

		this._toolbarDefinitions.set( toolbarId, {
			view: toolbarView,
			getRelatedElement,
			balloonClassName,
		} );
	}

	/**
	 * Iterates over stored toolbars and makes them visible or hidden.
	 *
	 * @private
	 */
	_updateToolbarsVisibility() {
		let maxRelatedElementDepth = 0;
		let deepestRelatedElement = null;
		let deepestToolbarDefinition = null;

		for ( const definition of this._toolbarDefinitions.values() ) {
			const relatedElement = definition.getRelatedElement( this.editor.editing.view.document.selection );

			if ( !this.editor.ui.focusTracker.isFocused || !relatedElement ) {
				this._hideToolbar( definition );
			} else {
				const relatedElementDepth = relatedElement.getAncestors().length;

				// Many toolbars can express willingness to be displayed but they do not know about
				// each other. Figure out which toolbar is deepest in the view tree to decide which
				// should be displayed. For instance, if a selected image is inside a table cell, display
				// the ImageToolbar rather than the TableToolbar (#60).
				if ( relatedElementDepth > maxRelatedElementDepth ) {
					maxRelatedElementDepth = relatedElementDepth;
					deepestRelatedElement = relatedElement;
					deepestToolbarDefinition = definition;
				}
			}
		}

		if ( deepestToolbarDefinition ) {
			this._showToolbar( deepestToolbarDefinition, deepestRelatedElement );
		}
	}

	/**
	 * Hides the given toolbar.
	 *
	 * @private
	 * @param {module:widget/widgettoolbarrepository~WidgetRepositoryToolbarDefinition} toolbarDefinition
	 */
	_hideToolbar( toolbarDefinition ) {
		if ( !this._isToolbarVisible( toolbarDefinition ) ) {
			return;
		}

		this._balloon.remove( toolbarDefinition.view );
	}

	/**
	 * Shows up the toolbar if the toolbar is not visible.
	 * Otherwise, repositions the toolbar's balloon when toolbar's view is the most top view in balloon stack.
	 *
	 * It might happen here that the toolbar's view is under another view. Then do nothing as the other toolbar view
	 * should be still visible after the {@link module:core/editor/editorui~EditorUI#event:update}.
	 *
	 * @private
	 * @param {module:widget/widgettoolbarrepository~WidgetRepositoryToolbarDefinition} toolbarDefinition
	 * @param {module:engine/view/element~Element} relatedElement
	 */
	_showToolbar( toolbarDefinition, relatedElement ) {
		if ( this._isToolbarVisible( toolbarDefinition ) ) {
			repositionContextualBalloon( this.editor, relatedElement );
		} else if ( !this._balloon.hasView( toolbarDefinition.view ) ) {
			this._balloon.add( {
				view: toolbarDefinition.view,
				position: getBalloonPositionData( this.editor, relatedElement ),
				balloonClassName: toolbarDefinition.balloonClassName,
			} );
		}
	}

	/**
	 * @private
	 * @param {Object} toolbar
	 */
	_isToolbarVisible( toolbar ) {
		return this._balloon.visibleView == toolbar.view;
	}
}

function repositionContextualBalloon( editor, relatedElement ) {
	const balloon = editor.plugins.get( 'ContextualBalloon' );
	const position = getBalloonPositionData( editor, relatedElement );

	balloon.updatePosition( position );
}

function getBalloonPositionData( editor, relatedElement ) {
	const editingView = editor.editing.view;
	const defaultPositions = BalloonPanelView.defaultPositions;

	return {
		target: editingView.domConverter.viewToDom( relatedElement ),
		positions: [
			defaultPositions.northArrowSouth,
			defaultPositions.northArrowSouthWest,
			defaultPositions.northArrowSouthEast,
			defaultPositions.southArrowNorth,
			defaultPositions.southArrowNorthWest,
			defaultPositions.southArrowNorthEast
		]
	};
}

function isWidgetSelected( selection ) {
	const viewElement = selection.getSelectedElement();

	return !!( viewElement && isWidget( viewElement ) );
}

/**
 * The toolbar definition object used by the toolbar repository to manage toolbars.
 * It contains information necessary to display the toolbar in the
 * {@link module:ui/panel/balloon/contextualballoon~ContextualBalloon contextual balloon} and
 * update it during its life (display) cycle.
 *
 * @typedef {Object} module:widget/widgettoolbarrepository~WidgetRepositoryToolbarDefinition
 *
 * @property {module:ui/view~View} view The UI view of the toolbar.
 * @property {Function} getRelatedElement A function that returns an engine {@link module:engine/view/view~View}
 * element the toolbar is to be attached to. For instance, an image widget or a table widget (or `null` when
 * there is no such element). The function accepts an instance of {@link module:engine/view/selection~Selection}.
 * @property {String} balloonClassName CSS class for the widget balloon when a toolbar is displayed.
 */
