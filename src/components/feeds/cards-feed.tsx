import * as React from "react"
import intl from "react-intl-universal"
import { FeedProps } from "./feed"
import DefaultCard from "../cards/default-card"
import { PrimaryButton, FocusZone } from "office-ui-fabric-react"
import { RSSItem } from "../../scripts/models/item"
import { List, AnimationClassNames } from "@fluentui/react"

class CardsFeed extends React.Component<FeedProps> {
    observer: ResizeObserver
    state = { width: window.innerWidth, height: window.innerHeight }

    updateWindowSize = (entries: ResizeObserverEntry[]) => {
        if (entries) {
            this.setState({
                width: entries[0].contentRect.width - 40,
                height: window.innerHeight,
            })
        }
    }

    componentDidMount() {
        this.setState({
            width: document.querySelector(".main").clientWidth - 40,
        })
        this.observer = new ResizeObserver(this.updateWindowSize)
        this.observer.observe(document.querySelector(".main"))
    }
    componentWillUnmount() {
        this.observer.disconnect()
    }

    getItemCountForPage = () => {
        let elemPerRow = Math.floor(this.state.width / 280)
        let rows = Math.ceil(this.state.height / 304)
        return elemPerRow * rows
    }
    getPageHeight = () => {
        return this.state.height + (304 - (this.state.height % 304))
    }

    flexFixItems = () => {
        let elemPerRow = Math.floor(this.state.width / 280)
        let elemLastRow = this.props.items.length % elemPerRow
        let items = [...this.props.items]
        for (let i = 0; i < elemPerRow - elemLastRow; i += 1) items.push(null)
        return items
    }
    onRenderItem = (item: RSSItem, index: number) =>
        item ? (
            <DefaultCard
                feedId={this.props.feed._id}
                key={item._id}
                item={item}
                source={this.props.sourceMap[item.source]}
                filter={this.props.filter}
                shortcuts={this.props.shortcuts}
                markRead={this.props.markRead}
                contextMenu={this.props.contextMenu}
                showItem={this.props.showItem}
            />
        ) : (
            <div className="flex-fix" key={"f-" + index}></div>
        )

    canFocusChild = (el: HTMLElement) => {
        if (el.id === "load-more") {
            const container = document.getElementById("refocus")
            const result =
                container.scrollTop >
                container.scrollHeight - 2 * container.offsetHeight
            if (!result) container.scrollTop += 100
            return result
        } else {
            return true
        }
    }

    /**
     * Handle keyboard events on the feed list.
     * When an article is displayed (currentItem is set) and the user presses
     * ArrowLeft/ArrowRight, trigger article navigation.
     * 
     * This is a fallback for when focus escapes from the WebContentsView
     * (e.g., during long-running scripts like NSFW-Cleanup or zoom automation).
     * The FocusZone captures the focus, but we still want navigation to work.
     */
    handleKeyDown = (e: React.KeyboardEvent) => {
        // Only handle ArrowLeft/ArrowRight when an article is displayed
        if (this.props.currentItem && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault()
            e.stopPropagation()
            
            // Save scroll position before navigation (prevents list jump)
            const scrollContainer = document.getElementById('refocus')
            const savedScrollTop = scrollContainer?.scrollTop ?? 0
            
            console.log(`[CardsFeed] Fallback navigation: ${e.key} (focus escaped to list)`)
            this.props.offsetItem(e.key === 'ArrowLeft' ? -1 : 1)
            
            // Request focus back to WebContentsView ASAP using requestAnimationFrame
            // This minimizes the visible focus on the list
            requestAnimationFrame(() => {
                // Restore scroll position if it changed unexpectedly
                if (scrollContainer && Math.abs(scrollContainer.scrollTop - savedScrollTop) > 100) {
                    scrollContainer.scrollTop = savedScrollTop
                }
                window.contentViewPool?.focus()
            })
        }
    }

    render() {
        return (
            this.props.feed.loaded && (
                <FocusZone
                    as="div"
                    id="refocus"
                    className="cards-feed-container"
                    shouldReceiveFocus={this.canFocusChild}
                    onKeyDown={this.handleKeyDown}
                    preventFocusRestoration={true}
                    data-is-scrollable>
                    <List
                        className={AnimationClassNames.slideUpIn10}
                        items={this.flexFixItems()}
                        onRenderCell={this.onRenderItem}
                        getItemCountForPage={this.getItemCountForPage}
                        getPageHeight={this.getPageHeight}
                        ignoreScrollingState
                        usePageCache
                    />
                    {this.props.feed.loaded && !this.props.feed.allLoaded ? (
                        <div className="load-more-wrapper">
                            <PrimaryButton
                                id="load-more"
                                text={intl.get("loadMore")}
                                disabled={this.props.feed.loading}
                                onClick={() =>
                                    this.props.loadMore(this.props.feed)
                                }
                            />
                        </div>
                    ) : null}
                    {this.props.items.length === 0 && (
                        <div className="empty">{intl.get("article.empty")}</div>
                    )}
                </FocusZone>
            )
        )
    }
}

export default CardsFeed
