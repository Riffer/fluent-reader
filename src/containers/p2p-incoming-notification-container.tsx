import { connect } from "react-redux"
import { RootState } from "../scripts/reducer"
import { pushP2PLink } from "../scripts/models/app"
import { navigateToP2PArticle } from "../scripts/models/page"
import P2PIncomingNotification from "../components/p2p-incoming-notification"

const mapStateToProps = (state: RootState) => ({
    // State props if needed
})

const mapDispatchToProps = (dispatch: any) => ({
    addToLog: (title: string, url: string, peerName: string, articleId?: number, sourceId?: number) => 
        dispatch(pushP2PLink(title, url, peerName, articleId, sourceId)),
    navigateToArticle: (sourceId: number, articleId: number, feedName: string) =>
        dispatch(navigateToP2PArticle(sourceId, articleId, feedName)),
})

const P2PIncomingNotificationContainer = connect(
    mapStateToProps,
    mapDispatchToProps
)(P2PIncomingNotification)

export default P2PIncomingNotificationContainer
