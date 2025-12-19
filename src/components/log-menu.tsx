import * as React from "react"
import intl from "react-intl-universal"
import {
    Callout,
    ActivityItem,
    Icon,
    DirectionalHint,
    Link,
} from "@fluentui/react"
import { AppLog, AppLogType } from "../scripts/models/app"
import Time from "./utils/time"

type LogMenuProps = {
    display: boolean
    logs: AppLog[]
    close: () => void
    showItem: (iid: number) => void
    showP2PArticle: (sourceId: number, articleId: number, feedName: string) => void
}

function getLogIcon(log: AppLog) {
    switch (log.type) {
        case AppLogType.Info:
            return "Info"
        case AppLogType.Article:
            return "KnowledgeArticle"
        case AppLogType.P2PLink:
            return "Share"
        default:
            return "Warning"
    }
}

class LogMenu extends React.Component<LogMenuProps> {
    activityItems = () =>
        this.props.logs
            .map((l, i) => ({
                key: i,
                activityDescription: l.type === AppLogType.P2PLink ? (
                    // P2P Link: check if stored in feed
                    l.iid && l.sourceId ? (
                        <b>
                            <Link onClick={() => this.handleP2PFeedArticleClick(l)}>
                                {l.title}
                            </Link>
                        </b>
                    ) : (
                        <b>
                            <Link onClick={() => this.handleP2PLinkClick(l)}>
                                {l.title}
                            </Link>
                        </b>
                    )
                ) : l.iid ? (
                    <b>
                        <Link onClick={() => this.handleArticleClick(l)}>
                            {l.title}
                        </Link>
                    </b>
                ) : (
                    <b>{l.title}</b>
                ),
                comments: l.details,
                activityIcon: <Icon iconName={getLogIcon(l)} />,
                timeStamp: <Time date={l.time} />,
            }))
            .reverse()

    handleArticleClick = (log: AppLog) => {
        this.props.close()
        this.props.showItem(log.iid)
    }

    handleP2PLinkClick = (log: AppLog) => {
        this.props.close()
        window.utils.openExternal(log.url)
    }

    handleP2PFeedArticleClick = (log: AppLog) => {
        this.props.close()
        // Navigate to the article in its P2P feed
        this.props.showP2PArticle(log.sourceId, log.iid, log.details || "P2P Feed")
    }

    render() {
        return (
            this.props.display && (
                <Callout
                    target="#log-toggle"
                    role="log-menu"
                    directionalHint={DirectionalHint.bottomCenter}
                    calloutWidth={320}
                    calloutMaxHeight={240}
                    onDismiss={this.props.close}>
                    {this.props.logs.length == 0 ? (
                        <p style={{ textAlign: "center" }}>
                            {intl.get("log.empty")}
                        </p>
                    ) : (
                        this.activityItems().map(item => (
                            <ActivityItem
                                {...item}
                                key={item.key}
                                style={{ margin: 12 }}
                            />
                        ))
                    )}
                </Callout>
            )
        )
    }
}

export default LogMenu
