import * as React from "react"
import { Card } from "./card"
import CardInfo from "./info"
import Highlights from "./highlights"
import { SourceTextDirection } from "../../scripts/models/source"
import { useTranslation } from "../utils/use-translation"

const className = (props: Card.Props, isTranslating: boolean) => {
    let cn = ["card", "magazine-card"]
    if (props.item.hasRead) cn.push("read")
    if (props.item.hidden) cn.push("hidden")
    if (props.source.textDir === SourceTextDirection.RTL) cn.push("rtl")
    if (isTranslating) cn.push("translating")
    return cn.join(" ")
}

const MagazineCard: React.FunctionComponent<Card.Props> = props => {
    // On-demand translation - only translates when component renders
    const { title, snippet, isTranslating } = useTranslation(props.item, props.source)
    
    return (
        <div
            className={className(props, isTranslating)}
            {...Card.bindEventsToProps(props)}
            data-iid={props.item._id}
            data-is-focusable>
            {props.item.thumb ? (
                <div className="head">
                    <img src={props.item.thumb} />
                </div>
            ) : null}
            <div className="data">
                <div>
                    <h3 className="title">
                        <Highlights
                            text={title}
                            filter={props.filter}
                            title
                        />
                    </h3>
                    <p className="snippet">
                        <Highlights
                            text={snippet}
                            filter={props.filter}
                        />
                    </p>
                </div>
                <CardInfo source={props.source} item={props.item} showCreator />
            </div>
        </div>
    )
}

export default MagazineCard
