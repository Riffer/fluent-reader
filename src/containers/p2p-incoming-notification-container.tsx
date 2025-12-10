import { connect } from "react-redux"
import { RootState } from "../scripts/reducer"
import { pushP2PLink } from "../scripts/models/app"
import P2PIncomingNotification from "../components/p2p-incoming-notification"

const mapStateToProps = (state: RootState) => ({
    // State props if needed
})

const mapDispatchToProps = (dispatch: any) => ({
    addToLog: (title: string, url: string, peerName: string) => 
        dispatch(pushP2PLink(title, url, peerName)),
})

const P2PIncomingNotificationContainer = connect(
    mapStateToProps,
    mapDispatchToProps
)(P2PIncomingNotification)

export default P2PIncomingNotificationContainer
