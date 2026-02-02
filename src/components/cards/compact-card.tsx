import * as React from "react"
import { Card } from "./card"
import CardInfo from "./info"
import Time from "../utils/time"
import Highlights from "./highlights"
import { SourceTextDirection } from "../../scripts/models/source"
import { useTranslation } from "../utils/use-translation"

const className = (props: Card.Props, isTranslating: boolean) => {
    let cn = ["card", "compact-card"]
    if (props.item.hidden) cn.push("hidden")
    if (props.source.textDir === SourceTextDirection.RTL) cn.push("rtl")
    if (isTranslating) cn.push("translating")
    return cn.join(" ")
}

const CompactCard: React.FunctionComponent<Card.Props> = props => {
    // On-demand translation - only translates when component renders
    const { title, snippet, isTranslating } = useTranslation(props.item, props.source)
    
    return (
        <div
            className={className(props, isTranslating)}
            {...Card.bindEventsToProps(props)}
            data-iid={props.item._id}
            data-is-focusable>
            <CardInfo source={props.source} item={props.item} hideTime />
            <div className="data">
                <span className="title">
                    <Highlights
                        text={title}
                        filter={props.filter}
                        title
                    />
                </span>
                <span className="snippet">
                    <Highlights text={snippet} filter={props.filter} />
                </span>
            </div>
            <Time date={props.item.date} />
        </div>
    )
}

export default CompactCard
